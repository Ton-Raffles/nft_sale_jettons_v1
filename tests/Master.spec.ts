import { Blockchain, SandboxContract, TreasuryContract, printTransactionFees } from '@ton/sandbox';
import { Cell, Dictionary, beginCell, toNano } from '@ton/core';
import { Master, createJettonPricesValue, JettonPrices } from '../wrappers/Master';
import { JettonMinter } from '../wrappers/JettonMinter';
import { JettonWallet } from '../wrappers/JettonWallet';
import { NFTItem } from '../wrappers/NFTItem';
import { NFTCollection } from '../wrappers/NFTCollection';
import { KeyPair, getSecureRandomBytes, keyPairFromSeed, sign } from '@ton/crypto';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import exp from 'constants';

describe('Master', () => {
    let masterCode: Cell;
    let jettonMinterCode: Cell;
    let jettonWalletCode: Cell;
    let nftItemCode: Cell;
    let nftCollectionCode: Cell;

    beforeAll(async () => {
        masterCode = await compile('Master');
        jettonMinterCode = await compile('JettonMinter');
        jettonWalletCode = await compile('JettonWallet');
        nftItemCode = await compile('NFTItem');
        nftCollectionCode = await compile('NFTCollection');
    });

    let blockchain: Blockchain;
    let deployer: SandboxContract<TreasuryContract>;
    let master: SandboxContract<Master>;
    let users: SandboxContract<TreasuryContract>[];
    let admins: SandboxContract<TreasuryContract>[];
    let jettonMinter1: SandboxContract<JettonMinter>;
    let jettonWallets1: SandboxContract<JettonWallet>[];
    let jettonWallets2: SandboxContract<JettonWallet>[];
    let jettonMinter2: SandboxContract<JettonMinter>;
    let keyPair: KeyPair;
    let collection: SandboxContract<NFTCollection>;
    let item: SandboxContract<NFTItem>;

    beforeEach(async () => {
        keyPair = keyPairFromSeed(await getSecureRandomBytes(32));
        blockchain = await Blockchain.create();
        blockchain.now = 1600000000;

        users = await blockchain.createWallets(100);
        admins = await blockchain.createWallets(5);
        deployer = await blockchain.treasury('deployer');

        jettonMinter1 = blockchain.openContract(
            JettonMinter.createFromConfig(
                {
                    admin: admins[0].address,
                    content: Cell.EMPTY,
                    walletCode: jettonWalletCode,
                },
                jettonMinterCode,
            ),
        );
        await jettonMinter1.sendDeploy(admins[0].getSender(), toNano('0.1'));

        for (let i = 0; i < 99; i++) {
            await jettonMinter1.sendMint(admins[0].getSender(), toNano('100'), 0n, users[i].address, toNano('10000'));
        }

        jettonWallets1 = await Promise.all(
            users.map(async (user) =>
                blockchain.openContract(
                    JettonWallet.createFromAddress(await jettonMinter1.getWalletAddressOf(user.address)),
                ),
            ),
        );

        jettonMinter2 = blockchain.openContract(
            JettonMinter.createFromConfig(
                {
                    admin: admins[1].address,
                    content: Cell.EMPTY,
                    walletCode: jettonWalletCode,
                },
                jettonMinterCode,
            ),
        );
        await jettonMinter2.sendDeploy(admins[1].getSender(), toNano('0.1'));

        for (let i = 0; i < 99; i++) {
            await jettonMinter2.sendMint(admins[1].getSender(), toNano('100'), 0n, users[i].address, toNano('10000'));
        }

        jettonWallets2 = await Promise.all(
            users.map(async (user) =>
                blockchain.openContract(
                    JettonWallet.createFromAddress(await jettonMinter2.getWalletAddressOf(user.address)),
                ),
            ),
        );

        collection = blockchain.openContract(
            NFTCollection.createFromConfig(
                {
                    owner: admins[1].address,
                    collectionContent: Cell.EMPTY,
                    commonContent: Cell.EMPTY,
                    itemCode: nftItemCode,
                    royaltyBase: 100n,
                    royaltyFactor: 100n,
                },
                nftCollectionCode,
            ),
        );
        await collection.sendDeploy(admins[1].getSender(), toNano('0.05'));

        item = blockchain.openContract((await collection.sendMint(admins[1].getSender(), toNano('0.05'), 0)).result);

        let r = await item.sendDeploy(admins[1].getSender(), toNano('0.05'));
    });

    it('should deploy', async () => {
        master = blockchain.openContract(
            Master.createFromConfig(
                {
                    createdAt: 0n,
                    marketplaceAddress: admins[0].address,
                    nftAddress: item.address,
                    fullPrice: toNano('1'),
                    jettonsConfigured: false,

                    feesCell: beginCell()
                        .storeAddress(admins[2].address)
                        .storeCoins(toNano('0.2'))
                        .storeAddress(admins[3].address)
                        .storeCoins(toNano('0.3'))
                        .endCell(),
                    publicKey: keyPair.publicKey,
                },
                masterCode,
            ),
        );

        let jettonPrice = Dictionary.empty(Dictionary.Keys.Address(), createJettonPricesValue());
        jettonPrice = jettonPrice.set(await jettonMinter1.getWalletAddressOf(master.address), {
            fullPrice: toNano('10'),
            marketplaceFee: toNano('1'),
            royaltyAmount: toNano('1'),
        });

        const deployResult = await master.sendDeploy(
            deployer.getSender(),
            toNano('0.05'),
            0n,
            sign(master.init?.data!.hash()!, keyPair.secretKey),
            jettonPrice,
        );

        expect(deployResult.transactions).toHaveTransaction({
            from: deployer.address,
            to: master.address,
            deploy: true,
            success: true,
        });

        let masterData = await master.getSaleData();

        expect(masterData.isComplete).toEqual(0n);
        expect(masterData.createdAt).toEqual(0n);
        expect(masterData.marketplaceAddress).toEqualAddress(admins[0].address);
        expect(masterData.nftAddress).toEqualAddress(item.address);
        expect(masterData.fullPrice).toEqual(toNano('1'));
        expect(masterData.marketplaceFeeAddress).toEqualAddress(admins[2].address);
        expect(masterData.marketplaceFee).toEqual(toNano('0.2'));
        expect(masterData.royaltyAddress).toEqualAddress(admins[3].address);
        expect(masterData.royaltyAmount).toEqual(toNano('0.3'));
    });

    it('should not deploy with wrong signature', async () => {
        master = blockchain.openContract(
            Master.createFromConfig(
                {
                    createdAt: 0n,
                    marketplaceAddress: admins[0].address,
                    nftAddress: item.address,
                    fullPrice: toNano('1'),
                    jettonsConfigured: false,
                    feesCell: beginCell()
                        .storeAddress(admins[2].address)
                        .storeCoins(toNano('0.2'))
                        .storeAddress(admins[3].address)
                        .storeCoins(toNano('0.3'))
                        .endCell(),
                    publicKey: keyPair.publicKey,
                },
                masterCode,
            ),
        );

        let jettonPrice = Dictionary.empty(Dictionary.Keys.Address(), createJettonPricesValue());
        jettonPrice = jettonPrice.set(await jettonMinter1.getWalletAddressOf(master.address), {
            fullPrice: toNano('10'),
            marketplaceFee: toNano('1'),
            royaltyAmount: toNano('1'),
        });

        const deployResult = await master.sendDeploy(
            deployer.getSender(),
            toNano('0.05'),
            0n,
            sign(master.init?.code!.hash()!, keyPair.secretKey),
            jettonPrice,
        );

        expect(deployResult.transactions).toHaveTransaction({
            from: deployer.address,
            to: master.address,
            deploy: true,
            success: false,
            exitCode: 902,
        });
    });

    it('should accept init message only from NFT', async () => {
        master = blockchain.openContract(
            Master.createFromConfig(
                {
                    createdAt: 0n,
                    marketplaceAddress: admins[0].address,
                    nftAddress: item.address,
                    fullPrice: toNano('1'),
                    jettonsConfigured: false,
                    feesCell: beginCell()
                        .storeAddress(admins[2].address)
                        .storeCoins(toNano('0.2'))
                        .storeAddress(admins[3].address)
                        .storeCoins(toNano('0.3'))
                        .endCell(),
                    publicKey: keyPair.publicKey,
                },
                masterCode,
            ),
        );

        let jettonPrice = Dictionary.empty(Dictionary.Keys.Address(), createJettonPricesValue());
        jettonPrice = jettonPrice.set(await jettonMinter1.getWalletAddressOf(master.address), {
            fullPrice: toNano('10'),
            marketplaceFee: toNano('1'),
            royaltyAmount: toNano('1'),
        });

        const deployResult = await master.sendDeploy(
            deployer.getSender(),
            toNano('0.05'),
            0n,
            sign(master.init?.data!.hash()!, keyPair.secretKey),
            jettonPrice,
        );

        expect(deployResult.transactions).toHaveTransaction({
            from: deployer.address,
            to: master.address,
            deploy: true,
            success: true,
        });

        let masterData = await master.getSaleData();

        expect(masterData.isComplete).toEqual(0n);
        expect(masterData.createdAt).toEqual(0n);
        expect(masterData.marketplaceAddress).toEqualAddress(admins[0].address);
        expect(masterData.nftAddress).toEqualAddress(item.address);
        expect(masterData.fullPrice).toEqual(toNano('1'));
        expect(masterData.marketplaceFeeAddress).toEqualAddress(admins[2].address);
        expect(masterData.marketplaceFee).toEqual(toNano('0.2'));
        expect(masterData.royaltyAddress).toEqualAddress(admins[3].address);
        expect(masterData.royaltyAmount).toEqual(toNano('0.3'));

        let res = await item.sendTransfer(admins[1].getSender(), toNano('1'), master.address);

        masterData = await master.getSaleData();

        expect(masterData.isComplete).toEqual(0n);
        expect(masterData.createdAt).toEqual(0n);
        expect(masterData.marketplaceAddress).toEqualAddress(admins[0].address);
        expect(masterData.nftOwnerAddress).toEqualAddress(admins[1].address);
        expect(masterData.nftAddress).toEqualAddress(item.address);
        expect(masterData.fullPrice).toEqual(toNano('1'));
        expect(masterData.marketplaceFeeAddress).toEqualAddress(admins[2].address);
        expect(masterData.marketplaceFee).toEqual(toNano('0.2'));
        expect(masterData.royaltyAddress).toEqualAddress(admins[3].address);
        expect(masterData.royaltyAmount).toEqual(toNano('0.3'));
    });

    it('should not buy if not initialized', async () => {
        master = blockchain.openContract(
            Master.createFromConfig(
                {
                    createdAt: 0n,
                    marketplaceAddress: admins[0].address,
                    nftAddress: item.address,
                    fullPrice: toNano('1'),
                    jettonsConfigured: false,
                    feesCell: beginCell()
                        .storeAddress(admins[2].address)
                        .storeCoins(toNano('0.2'))
                        .storeAddress(admins[3].address)
                        .storeCoins(toNano('0.3'))
                        .endCell(),
                    publicKey: keyPair.publicKey,
                },
                masterCode,
            ),
        );

        let jettonPrice = Dictionary.empty(Dictionary.Keys.Address(), createJettonPricesValue());
        jettonPrice = jettonPrice.set(await jettonMinter1.getWalletAddressOf(master.address), {
            fullPrice: toNano('10'),
            marketplaceFee: toNano('1'),
            royaltyAmount: toNano('1'),
        });

        const deployResult = await master.sendDeploy(
            deployer.getSender(),
            toNano('0.05'),
            0n,
            sign(master.init?.data!.hash()!, keyPair.secretKey),
            jettonPrice,
        );

        expect(deployResult.transactions).toHaveTransaction({
            from: deployer.address,
            to: master.address,
            deploy: true,
            success: true,
        });

        let masterData = await master.getSaleData();

        expect(masterData.isComplete).toEqual(0n);
        expect(masterData.createdAt).toEqual(0n);
        expect(masterData.marketplaceAddress).toEqualAddress(admins[0].address);
        expect(masterData.nftAddress).toEqualAddress(item.address);
        expect(masterData.fullPrice).toEqual(toNano('1'));
        expect(masterData.marketplaceFeeAddress).toEqualAddress(admins[2].address);
        expect(masterData.marketplaceFee).toEqual(toNano('0.2'));
        expect(masterData.royaltyAddress).toEqualAddress(admins[3].address);
        expect(masterData.royaltyAmount).toEqual(toNano('0.3'));

        let res = await master.sendBuy(users[0].getSender(), toNano('1'), 0n);

        expect(res.transactions).toHaveTransaction({
            from: users[0].address,
            to: master.address,
            success: false,
            exitCode: 500,
        });
    });

    it('should cancel sale', async () => {
        master = blockchain.openContract(
            Master.createFromConfig(
                {
                    createdAt: 0n,
                    marketplaceAddress: admins[0].address,
                    nftAddress: item.address,
                    fullPrice: toNano('1'),
                    jettonsConfigured: false,
                    feesCell: beginCell()
                        .storeAddress(admins[2].address)
                        .storeCoins(toNano('0.2'))
                        .storeAddress(admins[3].address)
                        .storeCoins(toNano('0.3'))
                        .endCell(),
                    publicKey: keyPair.publicKey,
                },
                masterCode,
            ),
        );

        let jettonPrice = Dictionary.empty(Dictionary.Keys.Address(), createJettonPricesValue());
        jettonPrice = jettonPrice.set(await jettonMinter1.getWalletAddressOf(master.address), {
            fullPrice: toNano('10'),
            marketplaceFee: toNano('1'),
            royaltyAmount: toNano('1'),
        });

        const deployResult = await master.sendDeploy(
            deployer.getSender(),
            toNano('0.05'),
            0n,
            sign(master.init?.data!.hash()!, keyPair.secretKey),
            jettonPrice,
        );

        expect(deployResult.transactions).toHaveTransaction({
            from: deployer.address,
            to: master.address,
            deploy: true,
            success: true,
        });

        let masterData = await master.getSaleData();

        expect(masterData.isComplete).toEqual(0n);
        expect(masterData.createdAt).toEqual(0n);
        expect(masterData.marketplaceAddress).toEqualAddress(admins[0].address);
        expect(masterData.nftAddress).toEqualAddress(item.address);
        expect(masterData.fullPrice).toEqual(toNano('1'));
        expect(masterData.marketplaceFeeAddress).toEqualAddress(admins[2].address);
        expect(masterData.marketplaceFee).toEqual(toNano('0.2'));
        expect(masterData.royaltyAddress).toEqualAddress(admins[3].address);
        expect(masterData.royaltyAmount).toEqual(toNano('0.3'));

        let res = await item.sendTransfer(admins[1].getSender(), toNano('1'), master.address);

        masterData = await master.getSaleData();

        expect(masterData.isComplete).toEqual(0n);
        expect(masterData.createdAt).toEqual(0n);
        expect(masterData.marketplaceAddress).toEqualAddress(admins[0].address);
        expect(masterData.nftOwnerAddress).toEqualAddress(admins[1].address);
        expect(masterData.nftAddress).toEqualAddress(item.address);
        expect(masterData.fullPrice).toEqual(toNano('1'));
        expect(masterData.marketplaceFeeAddress).toEqualAddress(admins[2].address);
        expect(masterData.marketplaceFee).toEqual(toNano('0.2'));
        expect(masterData.royaltyAddress).toEqualAddress(admins[3].address);
        expect(masterData.royaltyAmount).toEqual(toNano('0.3'));

        res = await master.sendСancel(admins[1].getSender(), toNano('1'), 0n);

        expect(res.transactions).toHaveTransaction({
            from: admins[1].address,
            to: master.address,
            success: true,
        });

        masterData = await master.getSaleData();

        expect(masterData.isComplete).toEqual(-1n);
        expect(masterData.createdAt).toEqual(0n);
        expect(masterData.marketplaceAddress).toEqualAddress(admins[0].address);
        expect(masterData.nftOwnerAddress).toEqualAddress(admins[1].address);
        expect(masterData.nftAddress).toEqualAddress(item.address);
        expect(masterData.fullPrice).toEqual(toNano('1'));
        expect(masterData.marketplaceFeeAddress).toEqualAddress(admins[2].address);
        expect(masterData.marketplaceFee).toEqual(toNano('0.2'));
        expect(masterData.royaltyAddress).toEqualAddress(admins[3].address);
        expect(masterData.royaltyAmount).toEqual(toNano('0.3'));

        expect(await item.getOwner()).toEqualAddress(admins[1].address);
    });

    it('should ignore any message if completed', async () => {
        master = blockchain.openContract(
            Master.createFromConfig(
                {
                    createdAt: 0n,
                    marketplaceAddress: admins[0].address,
                    nftAddress: item.address,
                    fullPrice: toNano('1'),
                    jettonsConfigured: false,
                    feesCell: beginCell()
                        .storeAddress(admins[2].address)
                        .storeCoins(toNano('0.2'))
                        .storeAddress(admins[3].address)
                        .storeCoins(toNano('0.3'))
                        .endCell(),
                    publicKey: keyPair.publicKey,
                },
                masterCode,
            ),
        );

        let jettonPrice = Dictionary.empty(Dictionary.Keys.Address(), createJettonPricesValue());
        jettonPrice = jettonPrice.set(await jettonMinter1.getWalletAddressOf(master.address), {
            fullPrice: toNano('10'),
            marketplaceFee: toNano('1'),
            royaltyAmount: toNano('1'),
        });

        const deployResult = await master.sendDeploy(
            deployer.getSender(),
            toNano('0.05'),
            0n,
            sign(master.init?.data!.hash()!, keyPair.secretKey),
            jettonPrice,
        );

        expect(deployResult.transactions).toHaveTransaction({
            from: deployer.address,
            to: master.address,
            deploy: true,
            success: true,
        });

        let masterData = await master.getSaleData();

        expect(masterData.isComplete).toEqual(0n);
        expect(masterData.createdAt).toEqual(0n);
        expect(masterData.marketplaceAddress).toEqualAddress(admins[0].address);
        expect(masterData.nftAddress).toEqualAddress(item.address);
        expect(masterData.fullPrice).toEqual(toNano('1'));
        expect(masterData.marketplaceFeeAddress).toEqualAddress(admins[2].address);
        expect(masterData.marketplaceFee).toEqual(toNano('0.2'));
        expect(masterData.royaltyAddress).toEqualAddress(admins[3].address);
        expect(masterData.royaltyAmount).toEqual(toNano('0.3'));

        let res = await item.sendTransfer(admins[1].getSender(), toNano('1'), master.address);

        masterData = await master.getSaleData();

        expect(masterData.isComplete).toEqual(0n);
        expect(masterData.createdAt).toEqual(0n);
        expect(masterData.marketplaceAddress).toEqualAddress(admins[0].address);
        expect(masterData.nftOwnerAddress).toEqualAddress(admins[1].address);
        expect(masterData.nftAddress).toEqualAddress(item.address);
        expect(masterData.fullPrice).toEqual(toNano('1'));
        expect(masterData.marketplaceFeeAddress).toEqualAddress(admins[2].address);
        expect(masterData.marketplaceFee).toEqual(toNano('0.2'));
        expect(masterData.royaltyAddress).toEqualAddress(admins[3].address);
        expect(masterData.royaltyAmount).toEqual(toNano('0.3'));

        res = await master.sendСancel(admins[1].getSender(), toNano('1'), 0n);

        expect(res.transactions).toHaveTransaction({
            from: admins[1].address,
            to: master.address,
            success: true,
        });

        masterData = await master.getSaleData();

        expect(masterData.isComplete).toEqual(-1n);
        expect(masterData.createdAt).toEqual(0n);
        expect(masterData.marketplaceAddress).toEqualAddress(admins[0].address);
        expect(masterData.nftOwnerAddress).toEqualAddress(admins[1].address);
        expect(masterData.nftAddress).toEqualAddress(item.address);
        expect(masterData.fullPrice).toEqual(toNano('1'));
        expect(masterData.marketplaceFeeAddress).toEqualAddress(admins[2].address);
        expect(masterData.marketplaceFee).toEqual(toNano('0.2'));
        expect(masterData.royaltyAddress).toEqualAddress(admins[3].address);
        expect(masterData.royaltyAmount).toEqual(toNano('0.3'));

        expect(await item.getOwner()).toEqualAddress(admins[1].address);

        res = await master.sendBuy(users[0].getSender(), toNano('1'), 0n);

        expect(res.transactions).toHaveTransaction({
            from: users[0].address,
            to: master.address,
            success: false,
            exitCode: 404,
        });
    });

    it('should buy nft by TONs', async () => {
        master = blockchain.openContract(
            Master.createFromConfig(
                {
                    createdAt: 0n,
                    marketplaceAddress: admins[0].address,
                    nftAddress: item.address,
                    fullPrice: toNano('1'),
                    jettonsConfigured: false,
                    feesCell: beginCell()
                        .storeAddress(admins[2].address)
                        .storeCoins(toNano('0.2'))
                        .storeAddress(admins[3].address)
                        .storeCoins(toNano('0.3'))
                        .endCell(),
                    publicKey: keyPair.publicKey,
                },
                masterCode,
            ),
        );

        let jettonPrice = Dictionary.empty(Dictionary.Keys.Address(), createJettonPricesValue());
        jettonPrice = jettonPrice.set(await jettonMinter1.getWalletAddressOf(master.address), {
            fullPrice: toNano('10'),
            marketplaceFee: toNano('1'),
            royaltyAmount: toNano('1'),
        });

        const deployResult = await master.sendDeploy(
            deployer.getSender(),
            toNano('0.05'),
            0n,
            sign(master.init?.data!.hash()!, keyPair.secretKey),
            jettonPrice,
        );

        expect(deployResult.transactions).toHaveTransaction({
            from: deployer.address,
            to: master.address,
            deploy: true,
            success: true,
        });

        let masterData = await master.getSaleData();

        expect(masterData.isComplete).toEqual(0n);
        expect(masterData.createdAt).toEqual(0n);
        expect(masterData.marketplaceAddress).toEqualAddress(admins[0].address);
        expect(masterData.nftAddress).toEqualAddress(item.address);
        expect(masterData.fullPrice).toEqual(toNano('1'));
        expect(masterData.marketplaceFeeAddress).toEqualAddress(admins[2].address);
        expect(masterData.marketplaceFee).toEqual(toNano('0.2'));
        expect(masterData.royaltyAddress).toEqualAddress(admins[3].address);
        expect(masterData.royaltyAmount).toEqual(toNano('0.3'));

        let res = await item.sendTransfer(admins[1].getSender(), toNano('1'), master.address);

        masterData = await master.getSaleData();

        expect(masterData.isComplete).toEqual(0n);
        expect(masterData.createdAt).toEqual(0n);
        expect(masterData.marketplaceAddress).toEqualAddress(admins[0].address);
        expect(masterData.nftOwnerAddress).toEqualAddress(admins[1].address);
        expect(masterData.nftAddress).toEqualAddress(item.address);
        expect(masterData.fullPrice).toEqual(toNano('1'));
        expect(masterData.marketplaceFeeAddress).toEqualAddress(admins[2].address);
        expect(masterData.marketplaceFee).toEqual(toNano('0.2'));
        expect(masterData.royaltyAddress).toEqualAddress(admins[3].address);
        expect(masterData.royaltyAmount).toEqual(toNano('0.3'));

        res = await master.sendBuy(users[0].getSender(), toNano('1.5'), 0n);

        expect(res.transactions).toHaveTransaction({
            from: users[0].address,
            to: master.address,
            success: true,
        });

        masterData = await master.getSaleData();

        expect(masterData.isComplete).toEqual(-1n);
        expect(masterData.createdAt).toEqual(0n);
        expect(masterData.marketplaceAddress).toEqualAddress(admins[0].address);
        expect(masterData.nftOwnerAddress).toEqualAddress(admins[1].address);
        expect(masterData.nftAddress).toEqualAddress(item.address);
        expect(masterData.fullPrice).toEqual(toNano('1'));
        expect(masterData.marketplaceFeeAddress).toEqualAddress(admins[2].address);
        expect(masterData.marketplaceFee).toEqual(toNano('0.2'));
        expect(masterData.royaltyAddress).toEqualAddress(admins[3].address);
        expect(masterData.royaltyAmount).toEqual(toNano('0.3'));

        expect(await item.getOwner()).toEqualAddress(users[0].address);
    });

    it('should buy nft by TONs without jettons', async () => {
        master = blockchain.openContract(
            Master.createFromConfig(
                {
                    createdAt: 0n,
                    marketplaceAddress: admins[0].address,
                    nftAddress: item.address,
                    fullPrice: toNano('1'),
                    jettonsConfigured: true,
                    feesCell: beginCell()
                        .storeAddress(admins[2].address)
                        .storeCoins(toNano('0.2'))
                        .storeAddress(admins[3].address)
                        .storeCoins(toNano('0.3'))
                        .endCell(),
                    publicKey: keyPair.publicKey,
                },
                masterCode,
            ),
        );

        const deployResult = await master.sendDeploy(
            deployer.getSender(),
            toNano('0.05'),
            0n,
            sign(master.init?.data!.hash()!, keyPair.secretKey),
        );

        expect(deployResult.transactions).toHaveTransaction({
            from: deployer.address,
            to: master.address,
            deploy: true,
            success: true,
        });

        let masterData = await master.getSaleData();

        expect(masterData.isComplete).toEqual(0n);
        expect(masterData.createdAt).toEqual(0n);
        expect(masterData.marketplaceAddress).toEqualAddress(admins[0].address);
        expect(masterData.nftAddress).toEqualAddress(item.address);
        expect(masterData.fullPrice).toEqual(toNano('1'));
        expect(masterData.marketplaceFeeAddress).toEqualAddress(admins[2].address);
        expect(masterData.marketplaceFee).toEqual(toNano('0.2'));
        expect(masterData.royaltyAddress).toEqualAddress(admins[3].address);
        expect(masterData.royaltyAmount).toEqual(toNano('0.3'));

        let res = await item.sendTransfer(admins[1].getSender(), toNano('1'), master.address);

        masterData = await master.getSaleData();

        expect(masterData.isComplete).toEqual(0n);
        expect(masterData.createdAt).toEqual(0n);
        expect(masterData.marketplaceAddress).toEqualAddress(admins[0].address);
        expect(masterData.nftOwnerAddress).toEqualAddress(admins[1].address);
        expect(masterData.nftAddress).toEqualAddress(item.address);
        expect(masterData.fullPrice).toEqual(toNano('1'));
        expect(masterData.marketplaceFeeAddress).toEqualAddress(admins[2].address);
        expect(masterData.marketplaceFee).toEqual(toNano('0.2'));
        expect(masterData.royaltyAddress).toEqualAddress(admins[3].address);
        expect(masterData.royaltyAmount).toEqual(toNano('0.3'));

        res = await master.sendBuy(users[0].getSender(), toNano('1.5'), 0n);

        expect(res.transactions).toHaveTransaction({
            from: users[0].address,
            to: master.address,
            success: true,
        });

        masterData = await master.getSaleData();

        expect(masterData.isComplete).toEqual(-1n);
        expect(masterData.createdAt).toEqual(0n);
        expect(masterData.marketplaceAddress).toEqualAddress(admins[0].address);
        expect(masterData.nftOwnerAddress).toEqualAddress(admins[1].address);
        expect(masterData.nftAddress).toEqualAddress(item.address);
        expect(masterData.fullPrice).toEqual(toNano('1'));
        expect(masterData.marketplaceFeeAddress).toEqualAddress(admins[2].address);
        expect(masterData.marketplaceFee).toEqual(toNano('0.2'));
        expect(masterData.royaltyAddress).toEqualAddress(admins[3].address);
        expect(masterData.royaltyAmount).toEqual(toNano('0.3'));

        expect(await item.getOwner()).toEqualAddress(users[0].address);
    });

    it('should not buy nft with empty TON price', async () => {
        master = blockchain.openContract(
            Master.createFromConfig(
                {
                    createdAt: 0n,
                    marketplaceAddress: admins[0].address,
                    nftAddress: item.address,
                    fullPrice: 0n,
                    jettonsConfigured: false,
                    feesCell: beginCell()
                        .storeAddress(admins[2].address)
                        .storeCoins(toNano('0.2'))
                        .storeAddress(admins[3].address)
                        .storeCoins(toNano('0.3'))
                        .endCell(),
                    publicKey: keyPair.publicKey,
                },
                masterCode,
            ),
        );

        let jettonPrice = Dictionary.empty(Dictionary.Keys.Address(), createJettonPricesValue());
        jettonPrice = jettonPrice.set(await jettonMinter1.getWalletAddressOf(master.address), {
            fullPrice: toNano('10'),
            marketplaceFee: toNano('1'),
            royaltyAmount: toNano('1'),
        });

        const deployResult = await master.sendDeploy(
            deployer.getSender(),
            toNano('0.05'),
            0n,
            sign(master.init?.data!.hash()!, keyPair.secretKey),
            jettonPrice,
        );

        expect(deployResult.transactions).toHaveTransaction({
            from: deployer.address,
            to: master.address,
            deploy: true,
            success: true,
        });

        let masterData = await master.getSaleData();

        expect(masterData.isComplete).toEqual(0n);
        expect(masterData.createdAt).toEqual(0n);
        expect(masterData.marketplaceAddress).toEqualAddress(admins[0].address);
        expect(masterData.nftAddress).toEqualAddress(item.address);
        expect(masterData.fullPrice).toEqual(0n);
        expect(masterData.marketplaceFeeAddress).toEqualAddress(admins[2].address);
        expect(masterData.marketplaceFee).toEqual(toNano('0.2'));
        expect(masterData.royaltyAddress).toEqualAddress(admins[3].address);
        expect(masterData.royaltyAmount).toEqual(toNano('0.3'));

        let res = await item.sendTransfer(admins[1].getSender(), toNano('1'), master.address);

        masterData = await master.getSaleData();

        expect(masterData.isComplete).toEqual(0n);
        expect(masterData.createdAt).toEqual(0n);
        expect(masterData.marketplaceAddress).toEqualAddress(admins[0].address);
        expect(masterData.nftOwnerAddress).toEqualAddress(admins[1].address);
        expect(masterData.nftAddress).toEqualAddress(item.address);
        expect(masterData.fullPrice).toEqual(0n);
        expect(masterData.marketplaceFeeAddress).toEqualAddress(admins[2].address);
        expect(masterData.marketplaceFee).toEqual(toNano('0.2'));
        expect(masterData.royaltyAddress).toEqualAddress(admins[3].address);
        expect(masterData.royaltyAmount).toEqual(toNano('0.3'));

        res = await master.sendBuy(users[0].getSender(), toNano('1.5'), 0n);

        expect(res.transactions).toHaveTransaction({
            from: users[0].address,
            to: master.address,
            success: false,
            exitCode: 451,
        });
    });

    it('should buy only for allowed jettons', async () => {
        master = blockchain.openContract(
            Master.createFromConfig(
                {
                    createdAt: 0n,
                    marketplaceAddress: admins[0].address,
                    nftAddress: item.address,
                    fullPrice: toNano('1'),
                    jettonsConfigured: true,
                    feesCell: beginCell()
                        .storeAddress(admins[2].address)
                        .storeCoins(toNano('0.2'))
                        .storeAddress(admins[3].address)
                        .storeCoins(toNano('0.3'))
                        .endCell(),
                    publicKey: keyPair.publicKey,
                },
                masterCode,
            ),
        );

        let jettonPrice = Dictionary.empty(Dictionary.Keys.Address(), createJettonPricesValue());
        jettonPrice = jettonPrice.set(await jettonMinter1.getWalletAddressOf(master.address), {
            fullPrice: toNano('10'),
            marketplaceFee: toNano('1'),
            royaltyAmount: toNano('1'),
        });

        const deployResult = await master.sendDeploy(
            deployer.getSender(),
            toNano('0.05'),
            0n,
            sign(master.init?.data!.hash()!, keyPair.secretKey),
            jettonPrice,
        );

        expect(deployResult.transactions).toHaveTransaction({
            from: deployer.address,
            to: master.address,
            deploy: true,
            success: true,
        });

        let masterData = await master.getSaleData();

        expect(masterData.isComplete).toEqual(0n);
        expect(masterData.createdAt).toEqual(0n);
        expect(masterData.marketplaceAddress).toEqualAddress(admins[0].address);
        expect(masterData.nftAddress).toEqualAddress(item.address);
        expect(masterData.fullPrice).toEqual(toNano('1'));
        expect(masterData.marketplaceFeeAddress).toEqualAddress(admins[2].address);
        expect(masterData.marketplaceFee).toEqual(toNano('0.2'));
        expect(masterData.royaltyAddress).toEqualAddress(admins[3].address);
        expect(masterData.royaltyAmount).toEqual(toNano('0.3'));

        let res = await item.sendTransfer(admins[1].getSender(), toNano('1'), master.address);

        masterData = await master.getSaleData();

        expect(masterData.isComplete).toEqual(0n);
        expect(masterData.createdAt).toEqual(0n);
        expect(masterData.marketplaceAddress).toEqualAddress(admins[0].address);
        expect(masterData.nftOwnerAddress).toEqualAddress(admins[1].address);
        expect(masterData.nftAddress).toEqualAddress(item.address);
        expect(masterData.fullPrice).toEqual(toNano('1'));
        expect(masterData.marketplaceFeeAddress).toEqualAddress(admins[2].address);
        expect(masterData.marketplaceFee).toEqual(toNano('0.2'));
        expect(masterData.royaltyAddress).toEqualAddress(admins[3].address);
        expect(masterData.royaltyAmount).toEqual(toNano('0.3'));

        await jettonWallets2[0].sendTransfer(
            users[0].getSender(),
            toNano('1'),
            toNano('1'),
            master.address,
            toNano('10'),
            Cell.EMPTY,
        );

        masterData = await master.getSaleData();

        expect(masterData.isComplete).toEqual(0n);
        expect(masterData.createdAt).toEqual(0n);
        expect(masterData.marketplaceAddress).toEqualAddress(admins[0].address);
        expect(masterData.nftOwnerAddress).toEqualAddress(admins[1].address);
        expect(masterData.nftAddress).toEqualAddress(item.address);
        expect(masterData.fullPrice).toEqual(toNano('1'));
        expect(masterData.marketplaceFeeAddress).toEqualAddress(admins[2].address);
        expect(masterData.marketplaceFee).toEqual(toNano('0.2'));
        expect(masterData.royaltyAddress).toEqualAddress(admins[3].address);
        expect(masterData.royaltyAmount).toEqual(toNano('0.3'));

        res = await jettonWallets1[0].sendTransfer(
            users[0].getSender(),
            toNano('1'),
            toNano('1'),
            master.address,
            toNano('10'),
            Cell.EMPTY,
        );

        masterData = await master.getSaleData();

        expect(masterData.isComplete).toEqual(-1n);
        expect(masterData.createdAt).toEqual(0n);
        expect(masterData.marketplaceAddress).toEqualAddress(admins[0].address);
        expect(masterData.nftOwnerAddress).toEqualAddress(admins[1].address);
        expect(masterData.nftAddress).toEqualAddress(item.address);
        expect(masterData.fullPrice).toEqual(toNano('1'));
        expect(masterData.marketplaceFeeAddress).toEqualAddress(admins[2].address);
        expect(masterData.marketplaceFee).toEqual(toNano('0.2'));
        expect(masterData.royaltyAddress).toEqualAddress(admins[3].address);
        expect(masterData.royaltyAmount).toEqual(toNano('0.3'));

        expect(await item.getOwner()).toEqualAddress(users[0].address);
    });

    it('should bounce jettons after finish', async () => {
        master = blockchain.openContract(
            Master.createFromConfig(
                {
                    createdAt: 0n,
                    marketplaceAddress: admins[0].address,
                    nftAddress: item.address,
                    fullPrice: toNano('1'),
                    jettonsConfigured: true,
                    feesCell: beginCell()
                        .storeAddress(admins[2].address)
                        .storeCoins(toNano('0.2'))
                        .storeAddress(admins[3].address)
                        .storeCoins(toNano('0.3'))
                        .endCell(),
                    publicKey: keyPair.publicKey,
                },
                masterCode,
            ),
        );

        let jettonPrice = Dictionary.empty(Dictionary.Keys.Address(), createJettonPricesValue());
        jettonPrice = jettonPrice.set(await jettonMinter1.getWalletAddressOf(master.address), {
            fullPrice: toNano('10'),
            marketplaceFee: toNano('1'),
            royaltyAmount: toNano('1'),
        });

        jettonPrice = jettonPrice.set(await jettonMinter2.getWalletAddressOf(master.address), {
            fullPrice: toNano('10'),
            marketplaceFee: toNano('1'),
            royaltyAmount: toNano('1'),
        });

        const deployResult = await master.sendDeploy(
            deployer.getSender(),
            toNano('0.05'),
            0n,
            sign(master.init?.data!.hash()!, keyPair.secretKey),
            jettonPrice,
        );

        expect(deployResult.transactions).toHaveTransaction({
            from: deployer.address,
            to: master.address,
            deploy: true,
            success: true,
        });

        let masterData = await master.getSaleData();

        expect(masterData.isComplete).toEqual(0n);
        expect(masterData.createdAt).toEqual(0n);
        expect(masterData.marketplaceAddress).toEqualAddress(admins[0].address);
        expect(masterData.nftAddress).toEqualAddress(item.address);
        expect(masterData.fullPrice).toEqual(toNano('1'));
        expect(masterData.marketplaceFeeAddress).toEqualAddress(admins[2].address);
        expect(masterData.marketplaceFee).toEqual(toNano('0.2'));
        expect(masterData.royaltyAddress).toEqualAddress(admins[3].address);
        expect(masterData.royaltyAmount).toEqual(toNano('0.3'));

        let res = await item.sendTransfer(admins[1].getSender(), toNano('1'), master.address);

        masterData = await master.getSaleData();

        expect(masterData.isComplete).toEqual(0n);
        expect(masterData.createdAt).toEqual(0n);
        expect(masterData.marketplaceAddress).toEqualAddress(admins[0].address);
        expect(masterData.nftOwnerAddress).toEqualAddress(admins[1].address);
        expect(masterData.nftAddress).toEqualAddress(item.address);
        expect(masterData.fullPrice).toEqual(toNano('1'));
        expect(masterData.marketplaceFeeAddress).toEqualAddress(admins[2].address);
        expect(masterData.marketplaceFee).toEqual(toNano('0.2'));
        expect(masterData.royaltyAddress).toEqualAddress(admins[3].address);
        expect(masterData.royaltyAmount).toEqual(toNano('0.3'));

        await jettonWallets2[0].sendTransfer(
            users[0].getSender(),
            toNano('1'),
            toNano('1'),
            master.address,
            toNano('10'),
            Cell.EMPTY,
        );

        masterData = await master.getSaleData();

        expect(masterData.isComplete).toEqual(-1n);
        expect(masterData.createdAt).toEqual(0n);
        expect(masterData.marketplaceAddress).toEqualAddress(admins[0].address);
        expect(masterData.nftOwnerAddress).toEqualAddress(admins[1].address);
        expect(masterData.nftAddress).toEqualAddress(item.address);
        expect(masterData.fullPrice).toEqual(toNano('1'));
        expect(masterData.marketplaceFeeAddress).toEqualAddress(admins[2].address);
        expect(masterData.marketplaceFee).toEqual(toNano('0.2'));
        expect(masterData.royaltyAddress).toEqualAddress(admins[3].address);
        expect(masterData.royaltyAmount).toEqual(toNano('0.3'));

        expect(await item.getOwner()).toEqualAddress(users[0].address);

        await jettonWallets1[0].sendTransfer(
            users[0].getSender(),
            toNano('1'),
            toNano('1'),
            master.address,
            toNano('10'),
            Cell.EMPTY,
        );

        masterData = await master.getSaleData();

        expect(masterData.isComplete).toEqual(-1n);
        expect(masterData.createdAt).toEqual(0n);
        expect(masterData.marketplaceAddress).toEqualAddress(admins[0].address);
        expect(masterData.nftOwnerAddress).toEqualAddress(admins[1].address);
        expect(masterData.nftAddress).toEqualAddress(item.address);
        expect(masterData.fullPrice).toEqual(toNano('1'));
        expect(masterData.marketplaceFeeAddress).toEqualAddress(admins[2].address);
        expect(masterData.marketplaceFee).toEqual(toNano('0.2'));
        expect(masterData.royaltyAddress).toEqualAddress(admins[3].address);
        expect(masterData.royaltyAmount).toEqual(toNano('0.3'));

        expect(await item.getOwner()).toEqualAddress(users[0].address);
        expect(await jettonWallets1[0].getJettonBalance()).toEqual(toNano('10000'));
    });

    it('should bounce jettons if not initialized', async () => {
        master = blockchain.openContract(
            Master.createFromConfig(
                {
                    createdAt: 0n,
                    marketplaceAddress: admins[0].address,
                    nftAddress: item.address,
                    fullPrice: 0n,
                    jettonsConfigured: false,
                    feesCell: beginCell()
                        .storeAddress(admins[2].address)
                        .storeCoins(toNano('0.2'))
                        .storeAddress(admins[3].address)
                        .storeCoins(toNano('0.3'))
                        .endCell(),
                    publicKey: keyPair.publicKey,
                },
                masterCode,
            ),
        );

        let jettonPrice = Dictionary.empty(Dictionary.Keys.Address(), createJettonPricesValue());
        jettonPrice = jettonPrice.set(await jettonMinter1.getWalletAddressOf(master.address), {
            fullPrice: toNano('10'),
            marketplaceFee: toNano('1'),
            royaltyAmount: toNano('1'),
        });

        jettonPrice = jettonPrice.set(await jettonMinter2.getWalletAddressOf(master.address), {
            fullPrice: toNano('10'),
            marketplaceFee: toNano('1'),
            royaltyAmount: toNano('1'),
        });

        const deployResult = await master.sendDeploy(
            deployer.getSender(),
            toNano('0.05'),
            0n,
            sign(master.init?.data!.hash()!, keyPair.secretKey),
        );

        expect(deployResult.transactions).toHaveTransaction({
            from: deployer.address,
            to: master.address,
            deploy: true,
            success: true,
        });

        let masterData = await master.getSaleData();

        expect(masterData.isComplete).toEqual(0n);
        expect(masterData.createdAt).toEqual(0n);
        expect(masterData.marketplaceAddress).toEqualAddress(admins[0].address);
        expect(masterData.marketplaceFeeAddress).toEqualAddress(admins[2].address);
        expect(masterData.marketplaceFee).toEqual(toNano('0.2'));
        expect(masterData.royaltyAddress).toEqualAddress(admins[3].address);
        expect(masterData.royaltyAmount).toEqual(toNano('0.3'));

        await jettonWallets2[0].sendTransfer(
            users[0].getSender(),
            toNano('1'),
            toNano('1'),
            master.address,
            toNano('10'),
            Cell.EMPTY,
        );

        masterData = await master.getSaleData();

        expect(masterData.isComplete).toEqual(0n);
        expect(masterData.createdAt).toEqual(0n);
        expect(masterData.marketplaceAddress).toEqualAddress(admins[0].address);
        expect(masterData.marketplaceFeeAddress).toEqualAddress(admins[2].address);
        expect(masterData.marketplaceFee).toEqual(toNano('0.2'));
        expect(masterData.royaltyAddress).toEqualAddress(admins[3].address);
        expect(masterData.royaltyAmount).toEqual(toNano('0.3'));

        expect(await jettonWallets2[0].getJettonBalance()).toEqual(toNano('10000'));
    });

    it('should return extra jettons', async () => {
        master = blockchain.openContract(
            Master.createFromConfig(
                {
                    createdAt: 0n,
                    marketplaceAddress: admins[0].address,
                    nftAddress: item.address,
                    fullPrice: 0n,
                    jettonsConfigured: false,
                    feesCell: beginCell()
                        .storeAddress(admins[2].address)
                        .storeCoins(toNano('0.2'))
                        .storeAddress(admins[3].address)
                        .storeCoins(toNano('0.3'))
                        .endCell(),
                    publicKey: keyPair.publicKey,
                },
                masterCode,
            ),
        );

        let jettonPrice = Dictionary.empty(Dictionary.Keys.Address(), createJettonPricesValue());
        jettonPrice = jettonPrice.set(await jettonMinter1.getWalletAddressOf(master.address), {
            fullPrice: toNano('10'),
            marketplaceFee: toNano('1'),
            royaltyAmount: toNano('1'),
        });

        jettonPrice = jettonPrice.set(await jettonMinter2.getWalletAddressOf(master.address), {
            fullPrice: toNano('10'),
            marketplaceFee: toNano('1'),
            royaltyAmount: toNano('1'),
        });

        const deployResult = await master.sendDeploy(
            deployer.getSender(),
            toNano('0.05'),
            0n,
            sign(master.init?.data!.hash()!, keyPair.secretKey),
            jettonPrice,
        );

        expect(deployResult.transactions).toHaveTransaction({
            from: deployer.address,
            to: master.address,
            deploy: true,
            success: true,
        });

        let masterData = await master.getSaleData();

        expect(masterData.isComplete).toEqual(0n);
        expect(masterData.createdAt).toEqual(0n);
        expect(masterData.marketplaceAddress).toEqualAddress(admins[0].address);
        expect(masterData.marketplaceFeeAddress).toEqualAddress(admins[2].address);
        expect(masterData.marketplaceFee).toEqual(toNano('0.2'));
        expect(masterData.royaltyAddress).toEqualAddress(admins[3].address);
        expect(masterData.royaltyAmount).toEqual(toNano('0.3'));

        let res = await item.sendTransfer(admins[1].getSender(), toNano('1'), master.address);

        masterData = await master.getSaleData();

        expect(masterData.isComplete).toEqual(0n);
        expect(masterData.createdAt).toEqual(0n);
        expect(masterData.marketplaceAddress).toEqualAddress(admins[0].address);
        expect(masterData.nftOwnerAddress).toEqualAddress(admins[1].address);
        expect(masterData.nftAddress).toEqualAddress(item.address);
        expect(masterData.fullPrice).toEqual(toNano('0'));
        expect(masterData.marketplaceFeeAddress).toEqualAddress(admins[2].address);
        expect(masterData.marketplaceFee).toEqual(toNano('0.2'));
        expect(masterData.royaltyAddress).toEqualAddress(admins[3].address);
        expect(masterData.royaltyAmount).toEqual(toNano('0.3'));

        res = await jettonWallets2[0].sendTransfer(
            users[0].getSender(),
            toNano('1'),
            toNano('1'),
            master.address,
            toNano('12'),
            Cell.EMPTY,
        );

        masterData = await master.getSaleData();

        expect(masterData.isComplete).toEqual(-1n);
        expect(masterData.createdAt).toEqual(0n);
        expect(masterData.marketplaceAddress).toEqualAddress(admins[0].address);
        expect(masterData.marketplaceFeeAddress).toEqualAddress(admins[2].address);
        expect(masterData.marketplaceFee).toEqual(toNano('0.2'));
        expect(masterData.royaltyAddress).toEqualAddress(admins[3].address);
        expect(masterData.royaltyAmount).toEqual(toNano('0.3'));

        expect(await jettonWallets2[0].getJettonBalance()).toEqual(toNano('10000') - toNano('10'));

        expect(await item.getOwner()).toEqualAddress(users[0].address);
    });

    it('should bounce jettons if smaller amount', async () => {
        master = blockchain.openContract(
            Master.createFromConfig(
                {
                    createdAt: 0n,
                    marketplaceAddress: admins[0].address,
                    nftAddress: item.address,
                    fullPrice: 0n,
                    jettonsConfigured: false,
                    feesCell: beginCell()
                        .storeAddress(admins[2].address)
                        .storeCoins(toNano('0.2'))
                        .storeAddress(admins[3].address)
                        .storeCoins(toNano('0.3'))
                        .endCell(),
                    publicKey: keyPair.publicKey,
                },
                masterCode,
            ),
        );

        let jettonPrice = Dictionary.empty(Dictionary.Keys.Address(), createJettonPricesValue());
        jettonPrice = jettonPrice.set(await jettonMinter1.getWalletAddressOf(master.address), {
            fullPrice: toNano('10'),
            marketplaceFee: toNano('1'),
            royaltyAmount: toNano('1'),
        });

        jettonPrice = jettonPrice.set(await jettonMinter2.getWalletAddressOf(master.address), {
            fullPrice: toNano('10'),
            marketplaceFee: toNano('1'),
            royaltyAmount: toNano('1'),
        });

        const deployResult = await master.sendDeploy(
            deployer.getSender(),
            toNano('0.05'),
            0n,
            sign(master.init?.data!.hash()!, keyPair.secretKey),
            jettonPrice,
        );

        expect(deployResult.transactions).toHaveTransaction({
            from: deployer.address,
            to: master.address,
            deploy: true,
            success: true,
        });

        let masterData = await master.getSaleData();

        expect(masterData.isComplete).toEqual(0n);
        expect(masterData.createdAt).toEqual(0n);
        expect(masterData.marketplaceAddress).toEqualAddress(admins[0].address);
        expect(masterData.marketplaceFeeAddress).toEqualAddress(admins[2].address);
        expect(masterData.marketplaceFee).toEqual(toNano('0.2'));
        expect(masterData.royaltyAddress).toEqualAddress(admins[3].address);
        expect(masterData.royaltyAmount).toEqual(toNano('0.3'));

        let res = await item.sendTransfer(admins[1].getSender(), toNano('1'), master.address);

        masterData = await master.getSaleData();

        expect(masterData.isComplete).toEqual(0n);
        expect(masterData.createdAt).toEqual(0n);
        expect(masterData.marketplaceAddress).toEqualAddress(admins[0].address);
        expect(masterData.nftOwnerAddress).toEqualAddress(admins[1].address);
        expect(masterData.nftAddress).toEqualAddress(item.address);
        expect(masterData.fullPrice).toEqual(toNano('0'));
        expect(masterData.marketplaceFeeAddress).toEqualAddress(admins[2].address);
        expect(masterData.marketplaceFee).toEqual(toNano('0.2'));
        expect(masterData.royaltyAddress).toEqualAddress(admins[3].address);
        expect(masterData.royaltyAmount).toEqual(toNano('0.3'));

        res = await jettonWallets2[0].sendTransfer(
            users[0].getSender(),
            toNano('1'),
            toNano('1'),
            master.address,
            toNano('9'),
            Cell.EMPTY,
        );

        masterData = await master.getSaleData();

        expect(masterData.isComplete).toEqual(0n);
        expect(masterData.createdAt).toEqual(0n);
        expect(masterData.marketplaceAddress).toEqualAddress(admins[0].address);
        expect(masterData.marketplaceFeeAddress).toEqualAddress(admins[2].address);
        expect(masterData.marketplaceFee).toEqual(toNano('0.2'));
        expect(masterData.royaltyAddress).toEqualAddress(admins[3].address);
        expect(masterData.royaltyAmount).toEqual(toNano('0.3'));

        expect(await jettonWallets2[0].getJettonBalance()).toEqual(toNano('10000'));
    });

    it('should allow cancel after buy', async () => {
        master = blockchain.openContract(
            Master.createFromConfig(
                {
                    createdAt: 0n,
                    marketplaceAddress: admins[0].address,
                    nftAddress: item.address,
                    fullPrice: toNano('1'),
                    jettonsConfigured: false,
                    feesCell: beginCell()
                        .storeAddress(admins[2].address)
                        .storeCoins(toNano('0.2'))
                        .storeAddress(admins[3].address)
                        .storeCoins(toNano('0.3'))
                        .endCell(),
                    publicKey: keyPair.publicKey,
                },
                masterCode,
            ),
        );

        let jettonPrice = Dictionary.empty(Dictionary.Keys.Address(), createJettonPricesValue());
        jettonPrice = jettonPrice.set(await jettonMinter1.getWalletAddressOf(master.address), {
            fullPrice: toNano('10'),
            marketplaceFee: toNano('1'),
            royaltyAmount: toNano('1'),
        });

        const deployResult = await master.sendDeploy(
            deployer.getSender(),
            toNano('0.05'),
            0n,
            sign(master.init?.data!.hash()!, keyPair.secretKey),
            jettonPrice,
        );

        expect(deployResult.transactions).toHaveTransaction({
            from: deployer.address,
            to: master.address,
            deploy: true,
            success: true,
        });

        let masterData = await master.getSaleData();

        expect(masterData.isComplete).toEqual(0n);
        expect(masterData.createdAt).toEqual(0n);
        expect(masterData.marketplaceAddress).toEqualAddress(admins[0].address);
        expect(masterData.nftAddress).toEqualAddress(item.address);
        expect(masterData.fullPrice).toEqual(toNano('1'));
        expect(masterData.marketplaceFeeAddress).toEqualAddress(admins[2].address);
        expect(masterData.marketplaceFee).toEqual(toNano('0.2'));
        expect(masterData.royaltyAddress).toEqualAddress(admins[3].address);
        expect(masterData.royaltyAmount).toEqual(toNano('0.3'));

        let res = await item.sendTransfer(admins[1].getSender(), toNano('1'), master.address);

        masterData = await master.getSaleData();

        expect(masterData.isComplete).toEqual(0n);
        expect(masterData.createdAt).toEqual(0n);
        expect(masterData.marketplaceAddress).toEqualAddress(admins[0].address);
        expect(masterData.nftOwnerAddress).toEqualAddress(admins[1].address);
        expect(masterData.nftAddress).toEqualAddress(item.address);
        expect(masterData.fullPrice).toEqual(toNano('1'));
        expect(masterData.marketplaceFeeAddress).toEqualAddress(admins[2].address);
        expect(masterData.marketplaceFee).toEqual(toNano('0.2'));
        expect(masterData.royaltyAddress).toEqualAddress(admins[3].address);
        expect(masterData.royaltyAmount).toEqual(toNano('0.3'));

        res = await master.sendBuy(users[0].getSender(), toNano('1.5'), 0n);

        expect(res.transactions).toHaveTransaction({
            from: users[0].address,
            to: master.address,
            success: true,
        });

        masterData = await master.getSaleData();

        expect(masterData.isComplete).toEqual(-1n);
        expect(masterData.createdAt).toEqual(0n);
        expect(masterData.marketplaceAddress).toEqualAddress(admins[0].address);
        expect(masterData.nftOwnerAddress).toEqualAddress(admins[1].address);
        expect(masterData.nftAddress).toEqualAddress(item.address);
        expect(masterData.fullPrice).toEqual(toNano('1'));
        expect(masterData.marketplaceFeeAddress).toEqualAddress(admins[2].address);
        expect(masterData.marketplaceFee).toEqual(toNano('0.2'));
        expect(masterData.royaltyAddress).toEqualAddress(admins[3].address);
        expect(masterData.royaltyAmount).toEqual(toNano('0.3'));

        expect(await item.getOwner()).toEqualAddress(users[0].address);

        res = await master.sendСancel(users[1].getSender(), toNano('0.05'), 0n);

        masterData = await master.getSaleData();

        expect(masterData.isComplete).toEqual(-1n);
        expect(masterData.createdAt).toEqual(0n);
        expect(masterData.marketplaceAddress).toEqualAddress(admins[0].address);
        expect(masterData.nftOwnerAddress).toEqualAddress(admins[1].address);
        expect(masterData.nftAddress).toEqualAddress(item.address);
        expect(masterData.fullPrice).toEqual(toNano('1'));
        expect(masterData.marketplaceFeeAddress).toEqualAddress(admins[2].address);
        expect(masterData.marketplaceFee).toEqual(toNano('0.2'));
        expect(masterData.royaltyAddress).toEqualAddress(admins[3].address);
        expect(masterData.royaltyAmount).toEqual(toNano('0.3'));

        expect(await item.getOwner()).toEqualAddress(users[0].address);
    });

    it('change ton price', async () => {
        master = blockchain.openContract(
            Master.createFromConfig(
                {
                    createdAt: 0n,
                    marketplaceAddress: admins[0].address,
                    nftAddress: item.address,
                    fullPrice: toNano('1'),
                    jettonsConfigured: false,
                    feesCell: beginCell()
                        .storeAddress(admins[2].address)
                        .storeCoins(toNano('0.2'))
                        .storeAddress(admins[3].address)
                        .storeCoins(toNano('0.3'))
                        .endCell(),
                    publicKey: keyPair.publicKey,
                },
                masterCode,
            ),
        );

        let jettonPrice = Dictionary.empty(Dictionary.Keys.Address(), createJettonPricesValue());
        jettonPrice = jettonPrice.set(await jettonMinter1.getWalletAddressOf(master.address), {
            fullPrice: toNano('10'),
            marketplaceFee: toNano('1'),
            royaltyAmount: toNano('1'),
        });

        jettonPrice = jettonPrice.set(await jettonMinter2.getWalletAddressOf(master.address), {
            fullPrice: toNano('10'),
            marketplaceFee: toNano('1'),
            royaltyAmount: toNano('1'),
        });

        const deployResult = await master.sendDeploy(
            deployer.getSender(),
            toNano('0.05'),
            0n,
            sign(master.init?.data!.hash()!, keyPair.secretKey),
            jettonPrice,
        );

        expect(deployResult.transactions).toHaveTransaction({
            from: deployer.address,
            to: master.address,
            deploy: true,
            success: true,
        });

        let masterData = await master.getSaleData();

        expect(masterData.isComplete).toEqual(0n);
        expect(masterData.createdAt).toEqual(0n);
        expect(masterData.marketplaceAddress).toEqualAddress(admins[0].address);
        expect(masterData.nftAddress).toEqualAddress(item.address);
        expect(masterData.fullPrice).toEqual(toNano('1'));
        expect(masterData.marketplaceFeeAddress).toEqualAddress(admins[2].address);
        expect(masterData.marketplaceFee).toEqual(toNano('0.2'));
        expect(masterData.royaltyAddress).toEqualAddress(admins[3].address);
        expect(masterData.royaltyAmount).toEqual(toNano('0.3'));

        let res = await item.sendTransfer(admins[1].getSender(), toNano('1'), master.address);

        masterData = await master.getSaleData();

        expect(masterData.isComplete).toEqual(0n);
        expect(masterData.createdAt).toEqual(0n);
        expect(masterData.marketplaceAddress).toEqualAddress(admins[0].address);
        expect(masterData.nftOwnerAddress).toEqualAddress(admins[1].address);
        expect(masterData.nftAddress).toEqualAddress(item.address);
        expect(masterData.fullPrice).toEqual(toNano('1'));
        expect(masterData.marketplaceFeeAddress).toEqualAddress(admins[2].address);
        expect(masterData.marketplaceFee).toEqual(toNano('0.2'));
        expect(masterData.royaltyAddress).toEqualAddress(admins[3].address);
        expect(masterData.royaltyAmount).toEqual(toNano('0.3'));

        res = await master.sendChangePrice(admins[1].getSender(), toNano('0.05'), 0n, toNano('2'));

        masterData = await master.getSaleData();

        expect(masterData.isComplete).toEqual(0n);
        expect(masterData.createdAt).toEqual(0n);
        expect(masterData.marketplaceAddress).toEqualAddress(admins[0].address);
        expect(masterData.nftOwnerAddress).toEqualAddress(admins[1].address);
        expect(masterData.nftAddress).toEqualAddress(item.address);
        expect(masterData.fullPrice).toEqual(toNano('2'));
        expect(masterData.marketplaceFeeAddress).toEqualAddress(admins[2].address);
        expect(masterData.marketplaceFee).toEqual(toNano('0.2'));
        expect(masterData.royaltyAddress).toEqualAddress(admins[3].address);
        expect(masterData.royaltyAmount).toEqual(toNano('0.3'));
    });
});
