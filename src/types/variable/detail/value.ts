import { Variable, VariableType, DecodedVariable, VariableLocation, VariableTypeToString } from "../variable";
import { EvmInterface } from "../../../interface/evm";
import { BN } from "bn.js";

import { decode as decodeStack } from "../decode/stack";
import { decode as decodeMemory } from "../decode/memory";
import { decode as decodeStorage } from "../decode/storage";

export class ValueDetail {
    variable: Variable;
    position: BN; // either the relative slot number or relative position in stack/memory
    offset: number | null; // used for storage locations
    type: VariableType;
    storageLength: number;
    memoryLength: number;

    constructor(variable: Variable) {
        this.variable = variable;
        this.position = new BN(0);
        this.memoryLength = 32;
    }

    getStorageUsed(): number {
        return this.storageLength;
    }

    clone(variable: Variable = this.variable): ValueDetail {
        let clone = new ValueDetail(variable);

        clone.position = this.position;

        clone.offset = this.offset;

        clone.type = this.type;

        clone.storageLength = this.storageLength;

        clone.memoryLength = this.memoryLength;

        return clone;
    }

    async decode(stack: BN[], memory: (number | null)[], _interface: EvmInterface, address: string): Promise<DecodedVariable> {
        let v: string = "(invalid value)";

        switch (this.variable.location) {
            case VariableLocation.Stack:
                v = decodeStack((this.variable.position || 0) + this.position.toNumber(), this, stack);
                break;
            case VariableLocation.Memory:
                v = decodeMemory((this.variable.position || 0), this.position.toNumber(), this, stack, memory);
                break;
            case VariableLocation.Storage:
                v = await decodeStorage(this.position, this.offset || 0, this.storageLength, this, _interface, address);
                break;
            default:
                break;
        }

        let decodedVariable = <DecodedVariable>{
            name: this.variable.name,
            type: VariableTypeToString(this.type),
            variablesReference: 0,
            value: v,
            result: v
        };

        return decodedVariable;
    }
}