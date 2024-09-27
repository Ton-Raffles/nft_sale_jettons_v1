import {
    Address,
    beginCell,
    Builder,
    Cell,
    Contract,
    contractAddress,
    ContractProvider,
    Dictionary,
    DictionaryValue,
    Sender,
    SendMode,
    Slice,
} from '@ton/core';
import { randomAddress } from '@ton/test-utils';

export type JettonPrices = {
    fullPrice: bigint;
    marketplaceFee: bigint;
    royaltyAmount: bigint;
};

export function createJettonPricesValue(): DictionaryValue<JettonPrices> {
    return {
        parse: (src: Slice): JettonPrices => {
            return {
                fullPrice: src.loadCoins(),
                marketplaceFee: src.loadCoins(),
                royaltyAmount: src.loadCoins(),
            };
        },
        serialize: (src: JettonPrices, dest: Builder) => {
            dest.storeCoins(src.fullPrice);
            dest.storeCoins(src.marketplaceFee);
            dest.storeCoins(src.royaltyAmount);
        },
    };
}

export type MasterConfig = {
    createdAt: bigint;
    marketplaceAddress: Address;
    nftAddress: Address;
    fullPrice: bigint;
    feesCell: Cell;
    jettonsConfigured: boolean;
    publicKey: Buffer;
};

export function masterConfigToCell(config: MasterConfig): Cell {
    return beginCell()
        .storeRef(
            beginCell()
                .storeUint(0, 1)
                .storeUint(config.createdAt, 32)
                .storeAddress(config.marketplaceAddress)
                .storeAddress(config.nftAddress)
                .storeUint(0, 2)
                .endCell(),
        )
        .storeUint(0, 1)
        .storeCoins(config.fullPrice)
        .storeRef(config.feesCell)
        .storeUint(config.jettonsConfigured ? 1 : 0, 1)
        .storeDict(null)
        .storeBuffer(config.publicKey)
        .endCell();
}

export class Master implements Contract {
    constructor(
        readonly address: Address,
        readonly init?: { code: Cell; data: Cell },
    ) {}

    static createFromAddress(address: Address) {
        return new Master(address);
    }

    static createFromConfig(config: MasterConfig, code: Cell, workchain = 0) {
        const data = masterConfigToCell(config);
        const init = { code, data };
        return new Master(contractAddress(workchain, init), init);
    }

    async sendDeploy(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        queryId: bigint,
        signature: Buffer,
        jettonPrices?: Dictionary<Address, JettonPrices>,
    ) {
        let sl = jettonPrices ? beginCell().storeDict(jettonPrices).endCell().beginParse() : null;
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(5, 32)
                .storeUint(queryId, 64)
                .storeBuffer(signature)
                .storeMaybeSlice(sl)
                .endCell(),
        });
    }

    async sendChangePrice(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        queryId: bigint,
        tonPrice?: bigint,
        jettonPrices?: Dictionary<Address, JettonPrices>,
    ) {
        let sl = jettonPrices ? beginCell().storeDict(jettonPrices).endCell().beginParse() : null;
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(5, 32)
                .storeUint(queryId, 64)
                .storeMaybeCoins(tonPrice)
                .storeMaybeSlice(sl)
                .endCell(),
        });
    }

    async sendСancel(provider: ContractProvider, via: Sender, value: bigint, queryId: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().storeUint(3, 32).storeUint(queryId, 64).endCell(),
        });
    }

    async sendCastomMessage(provider: ContractProvider, via: Sender, value: bigint, queryId: bigint, msg: Cell) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().storeUint(555, 32).storeUint(queryId, 64).storeRef(msg).endCell(),
        });
    }

    async sendBuy(provider: ContractProvider, via: Sender, value: bigint, queryId: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().storeUint(0, 32).storeUint(queryId, 64).endCell(),
        });
    }

    async getSaleData(provider: ContractProvider): Promise<{
        isComplete: bigint;
        createdAt: bigint;
        marketplaceAddress: Address;
        nftAddress: Address;
        nftOwnerAddress: Address | null;
        fullPrice: bigint;
        jettonePrices: Dictionary<Address, JettonPrices>;
        marketplaceFeeAddress: Address;
        marketplaceFee: bigint;
        royaltyAddress: Address;
        royaltyAmount: bigint;
    }> {
        const res = (await provider.get('get_sale_data', [])).stack;
        res.skip(1);
        return {
            isComplete: res.readBigNumber(),
            createdAt: res.readBigNumber(),
            marketplaceAddress: res.readAddress(),
            nftAddress: res.readAddress(),
            nftOwnerAddress: res.readAddressOpt(),
            fullPrice: res.readBigNumber(),
            jettonePrices:
                res.readCellOpt()?.beginParse().loadDictDirect(Dictionary.Keys.Address(), createJettonPricesValue()) ??
                Dictionary.empty(Dictionary.Keys.Address(), createJettonPricesValue()),
            marketplaceFeeAddress: res.readAddress(),
            marketplaceFee: res.readBigNumber(),
            royaltyAddress: res.readAddress(),
            royaltyAmount: res.readBigNumber(),
        };
    }
}
