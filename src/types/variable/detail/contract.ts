import { Variable, DecodedVariable } from "../variable";
import { BN } from "bn.js";
import { EvmInterface } from "../../../interface/evm";

export class ContractDetail {
    variable: Variable;
    position: BN; // either the slot number or relative position in stack/memory
    offset: number | null; // used for storage locations
    id: number;
    name: string;
    storageLength: number;
    memoryLength: number;

    constructor(variable: Variable) {
        this.variable = variable;
        this.position = new BN(0);
        this.id = Variable.nextId++;
        this.memoryLength = 32; // essentially an address
        this.storageLength = 20; // TODO: does it only take up a 20 byte address?
    }

    getStorageUsed(): number {
        return this.storageLength;
    }

    childIds(): number[] {
        let ids: number[] = [];

        return ids;
    }

    clone(variable: Variable = this.variable): ContractDetail {
        let clone = new ContractDetail(variable);

        clone.position = this.position;

        clone.offset = this.offset;

        clone.name = this.name;

        clone.storageLength = this.storageLength;

        clone.memoryLength = this.memoryLength;

        return clone;
    }

    async decodeChildren(stack: BN[], memory: (number | null)[], _interface: EvmInterface, address: string): Promise<DecodedVariable[]> {
        let decodedVariables: DecodedVariable[] = [];

        return decodedVariables;
    }

    async decode(stack: BN[], memory: (number | null)[], _interface: EvmInterface, address: string): Promise<DecodedVariable> {
        let decodedVariable = <DecodedVariable>{
            name: this.variable.name,
            type: this.name,
            variablesReference: 0, //this.id, // TODO: this is 0 temporarily until we can implement children
            value: "Contract" + (this.name ? (" " + this.name) : ""),
            result: ""
        };

        return decodedVariable;
    }
}