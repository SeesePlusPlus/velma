import { Variable, DecodedVariable, VariableLocation } from "../variable";
import { ValueDetail } from "./value";
import { BN } from "bn.js";
import { LibSdbInterface } from "../../../interface/interface";
import { LibSdbTypes } from "../../types";
import { VariableProcessor } from "../definition/processor";

export class StructDetail {
    variable: Variable;
    position: BN; // either the slot number or relative position in stack/memory
    location: VariableLocation;
    isPointer: boolean; // pointer vs reference (used for storage locations)
    offset: number | null; // used for storage locations
    id: number;
    name: string;
    members: {
        name: string;
        detail: (LibSdbTypes.VariableDetailType | null)
    }[];
    memoryLength: number;

    constructor(variable: Variable) {
        this.variable = variable;
        this.position = new BN(0);
        this.id = Variable.nextId++;
        this.members = [];
    }

    getStorageUsed(): number {
        let storageUsed: number = 0;

        for (let i = 0; i < this.members.length; i++) {
            const detail = this.members[i].detail;
            if (detail !== null) {
                storageUsed += detail.getStorageUsed();
            }
        }

        // structs use the entire slot
        return Math.ceil(storageUsed / 32) * 32;
    }

    childIds(): number[] {
        let ids: number[] = [];

        for (let i = 0; i < this.members.length; i++) {
            const type = this.members[i].detail;
            if (!(type instanceof ValueDetail) && type !== null) {
                ids.push(type.id);
                ids = ids.concat(type.childIds());
            }
        }

        return ids;
    }

    clone(variable: Variable = this.variable): StructDetail {
        let clone = new StructDetail(variable);

        clone.position = this.position;

        clone.location = this.location;

        clone.isPointer = this.isPointer;

        clone.offset = this.offset;

        clone.name = this.name;

        for (let i = 0; i < this.members.length; i++) {
            clone.members.push({
                name: this.members[i].name,
                detail: this.members[i].detail === null ? null : this.members[i].detail!.clone(variable)
            });
        }

        clone.memoryLength = this.memoryLength;

        return clone;
    }

    assignMemberPositions(): void {
        const processor = new VariableProcessor(this.variable, this.position, 0);
        for (let i = 0; i < this.members.length; i++) {
            if (this.members[i].detail !== null) {
                processor.applyStoragePositions(this.members[i].detail!);
            }
        }
    }

    async decodeChildren(stack: BN[], memory: (number | null)[], _interface: LibSdbInterface, address: string): Promise<DecodedVariable[]> {
        let decodedVariables: DecodedVariable[] = [];

        if (this.isPointer && this.variable.position && this.variable.position < stack.length) {
            this.position = stack[this.variable.position].clone();
            this.assignMemberPositions();
        }

        for (let i = 0; i < this.members.length; i++) {
            let decodedVariable: DecodedVariable;
            if (this.members[i].detail === null) {
                decodedVariable = <DecodedVariable>{
                    type: "",
                    variablesReference: 0,
                    value: "(unsupported type)",
                    result: ""
                };
            }
            else {
                decodedVariable = await this.members[i].detail!.decode(stack, memory, _interface, address);
            }
            decodedVariable.name = this.members[i].name;
            decodedVariables.push(decodedVariable);
        }

        return decodedVariables;
    }

    async decode(stack: BN[], memory: (number | null)[], _interface: LibSdbInterface, address: string): Promise<DecodedVariable> {
        let decodedVariable = <DecodedVariable>{
            name: this.variable.name,
            type: this.name,
            variablesReference: this.id,
            value: "Struct",
            result: ""
        };

        return decodedVariable;
    }
}