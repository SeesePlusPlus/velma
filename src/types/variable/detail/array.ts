import { Variable, DecodedVariable, VariableLocation } from "../variable";
import { ValueDetail } from "./value";
import { BN } from "bn.js";
import { LibSdbInterface } from "../../../interface/interface";
import { LibSdbTypes } from "../../types";
import { VariableProcessor } from "../definition/processor";

export class ArrayDetail {
    variable: Variable;
    location: VariableLocation;
    isPointer: boolean; // pointer vs reference (used for storage locations)
    position: BN; // either the slot number or relative position in stack/memory
    offset: number | null; // used for storage locations
    id: number;
    isDynamic: boolean;
    memberType: LibSdbTypes.VariableDetailType;
    length: number;
    members: (ArrayDetail["memberType"])[];
    memoryLength: number;
    // From spec: For memory arrays, it cannot be a mapping and has to be an ABI
    //   type if it is an argument of a publicly-visible function.

    constructor(variable: Variable) {
        this.variable = variable;
        this.position = new BN(0);
        this.id = Variable.nextId++;
        this.members = [];
    }

    getStorageUsed(): number {
        if (this.isDynamic) {
            // dynamic arrays only take up one slot; the other array data is at keccak256(p)
            //   and is not applicable in this context (figuring out how many slots have been used in terms of 'p')
            return 32;
        }
        else {
            let storageUsed: number = 0;

            for (let i = 0; i < this.members.length; i++) {
                const detail = this.members[i];
                if (detail !== null) {
                    storageUsed += detail.getStorageUsed();
                }
            }

            // structs use the entire slot
            return Math.ceil(storageUsed / 32) * 32;
        }
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

    clone(variable: Variable = this.variable): ArrayDetail {
        let clone = new ArrayDetail(variable);

        clone.location = this.location;

        clone.isPointer = this.isPointer;

        clone.position = this.position;

        clone.offset = this.offset;

        clone.isDynamic = this.isDynamic;

        clone.memberType = this.memberType.clone();

        clone.length = this.length;

        for (let i = 0; i < this.members.length; i++) {
            clone.members.push(this.members[i].clone(variable));
        }

        clone.memoryLength = this.memoryLength;

        return clone;
    }

    assignMemberPositions(): void {
        const processor = new VariableProcessor(this.variable, this.position, 0);
        for (let i = 0; i < this.members.length; i++) {
            processor.applyStoragePositions(this.members[i]);
        }
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

        if (this.isPointer && this.variable.position && this.variable.position < stack.length) {
            this.position = stack[this.variable.position].clone();
            this.assignMemberPositions();
        }

        for (let i = 0; i < this.members.length; i++) {
            let decodedVariable = await this.members[i].decode(stack, memory, _interface, address);
            decodedVariable.name = i.toString();
            decodedVariables.push(decodedVariable);
        }

        return decodedVariables;
    }

    async decode(stack: BN[], memory: (number | null)[], _interface: LibSdbInterface, address: string): Promise<DecodedVariable> {
        let decodedVariable = <DecodedVariable> {
            name: this.variable.name,
            type: "array",
            variablesReference: this.id,
            value: "Array(" + this.length + ")",
            result: ""
        };

        return decodedVariable;
    }
}