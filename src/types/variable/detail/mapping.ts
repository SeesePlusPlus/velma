import { Variable, DecodedVariable } from "../variable";
import { ValueDetail } from "./value";
import { ArrayDetail } from "./array";
import { BN } from "bn.js";
import { LibSdbInterface } from "../../../interface/interface";
import { LibSdbTypes } from "../../types";

export class MappingDetail {
    variable: Variable;
    position: BN; // either the slot number or relative position in stack/memory
    offset: number | null; // used for storage locations
    id: number;
    key: ValueDetail | ArrayDetail; // cant be dynamic array or contract
    value: LibSdbTypes.VariableDetailType | null
    memoryLength: number;
    // Mappings are only allowed for state variables (or as storage reference types in internal functions)

    constructor(variable: Variable) {
        this.variable = variable;
        this.position = new BN(0);
        this.id = Variable.nextId++;
    }

    getStorageUsed(): number {
        // for this context (determing number of 'p' slots used), mappings only take the initial 
        return 32;
    }

    childIds(): number[] {
        let ids: number[] = [];

        if (!(this.key instanceof ValueDetail)) {
            ids.push(this.key.id);
            ids = ids.concat(this.key.childIds());
        }

        if (!(this.value instanceof ValueDetail) && this.value !== null) {
            ids.push(this.value.id);
            ids = ids.concat(this.value.childIds());
        }

        return ids;
    }

    clone(variable: Variable = this.variable): MappingDetail {
        let clone = new MappingDetail(variable);

        clone.position = this.position;

        clone.offset = this.offset;

        clone.key = this.key.clone(variable);

        clone.value = this.value === null ? null : this.value.clone(variable);

        clone.memoryLength = this.memoryLength;

        return clone;
    }

    async decodeChildren(stack: BN[], memory: (number | null)[], _interface: LibSdbInterface, address: string): Promise<DecodedVariable[]> {
        return [];
    }

    async decode(stack: BN[], memory: (number | null)[], _interface: LibSdbInterface, address: string): Promise<DecodedVariable> {
        let decodedVariable = <DecodedVariable> {
            name: this.variable.name,
            type: "mapping",
            variablesReference: 0, // we can't decode children for mapping's, see https://bit.ly/2G29Oma for details
            value: this.variable.originalType,
            result: ""
        };

        return decodedVariable;
    }
}