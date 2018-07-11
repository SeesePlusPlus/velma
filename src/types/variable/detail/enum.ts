import { ValueDetail } from "./value";
import { EnumDefinition } from "../../enum";
import { Variable, DecodedVariable, VariableLocation, VariableType, VariableTypeToString } from "../variable";
import { EvmInterface } from "../../../interface/evm";
import { BN } from "bn.js";

import { decode as decodeStack } from "../decode/stack";
import { decode as decodeMemory } from "../decode/memory";
import { decode as decodeStorage } from "../decode/storage";

export class EnumDetail extends ValueDetail {
    public definition: EnumDefinition;

    constructor(variable: Variable) {
        super(variable);

        this.type = VariableType.Enum;
    }

    getStorageUsed(): number {
        return super.getStorageUsed();
    }

    clone(variable: Variable = this.variable): EnumDetail {
        let clone = new EnumDetail(this.variable);

        clone.position = this.position;

        clone.offset = this.offset;

        clone.type = this.type;

        clone.storageLength = this.storageLength;

        clone.memoryLength = this.memoryLength;

        clone.definition = this.definition.clone();

        return clone;
    }

    async decode(stack: BN[], memory: (number | null)[], _interface: EvmInterface, address: string): Promise<DecodedVariable> {
        let v: string = "";

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