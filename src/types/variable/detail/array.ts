import { Variable, DecodedVariable } from "../variable";
import { ValueDetail } from "./value";
import { StructDetail } from "./struct";
import { MappingDetail } from "./mapping";
import { BN } from "bn.js";
import { LibSdbInterface } from "../../../interface";

export class ArrayDetail {
    variable: Variable;
    position: number | null;
    offset: number | null; // used for storage locations
    id: number;
    isDynamic: boolean;
    members: (ValueDetail | ArrayDetail | StructDetail | MappingDetail)[];
    // From spec: For memory arrays, it cannot be a mapping and has to be an ABI
    //   type if it is an argument of a publicly-visible function.

    constructor(variable: Variable) {
        this.variable = variable;
        this.id = Variable.nextId++;
    }

    childIds(): number[] {
        let ids: number[] = [];

        for (let i = 0; i < this.members.length; i++) {
            const type = this.members[i];
            if (!(type instanceof ValueDetail)) {
                ids.push(type.id);
                ids = ids.concat(type.childIds());
            }
        }

        return ids;
    }

    clone(): ArrayDetail {
        let clone = new ArrayDetail(this.variable);

        clone.isDynamic = this.isDynamic;

        for (let i = 0; i < this.members.length; i++) {
            clone.members.push(this.members[i].clone());
        }

        return clone;
    }

    async decodeChildren(stack: BN[], memory: (number | null)[], _interface: LibSdbInterface, address: string): Promise<DecodedVariable[]> {
        let decodedVariables: DecodedVariable[] = [];

        decodedVariables.push(<DecodedVariable> {
            name: "length",
            type: "number",
            variablesReference: 0,
            value: this.members.length.toString(),
            result: this.members.length.toString()
        });

        for (let i = 0; i < this.members.length; i++) {
            let decodedVariable = await this.members[i].decode(stack, memory, _interface, address);
            decodedVariable.name = i.toString();
            decodedVariables.push(decodedVariable);
        }

        return decodedVariables;
    }

    async decode(stack: BN[], memory: (number | null)[], _interface: LibSdbInterface, address: string): Promise<DecodedVariable> {
        let decodedVariable = <DecodedVariable> {
            name: "(unknown name)",
            type: "array",
            variablesReference: this.id,
            value: "",
            result: ""
        };

        return decodedVariable;
    }
}