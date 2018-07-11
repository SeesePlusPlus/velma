import { AstScope } from "../astScope";
import { DebugProtocol } from "vscode-debugprotocol/lib/debugProtocol";

import { VariableProcessor } from "./definition/processor";
import { LibSdbTypes } from "../types";
import { ContractProcessor } from "../../compilation/contractProcessor";
import { LibSdbConstants } from "../../utils/constants";

export enum VariableLocation {
    Stack,
    Memory,
    Storage,
    CallData
}

export enum VariableType {
    Boolean,
    UnsignedInteger,
    Integer,
    FixedPoint,
    Address,
    FixedByteArray,
    Enum,
    Function,
    Struct,
    Mapping,
    ByteArray,
    Contract,
    String,
    None
}

export function VariableTypeToString(type: VariableType): string {
    switch (type) {
        case VariableType.Boolean:
            return "bool";
        case VariableType.UnsignedInteger:
            return "uint";
        case VariableType.Integer:
            return "int";
        case VariableType.FixedPoint:
            return "fixedpoint";
        case VariableType.Address:
            return "address";
        case VariableType.FixedByteArray:
            return "bytes";
        case VariableType.Enum:
            return "enum";
        case VariableType.Function:
            return "function";
        default:
            return "";
    }
}

export enum VariableRefType {
    Array,
    Struct,
    Mapping,
    None
}

export interface DecodedVariable extends DebugProtocol.Variable {
    result: string; // same as value
}

export type VariableReferenceMap = Map<number, LibSdbTypes.VariableDetailType>;

export class Variable {
    id: number;
    name: string;
    position: number | null; // position in stack to value or pointer
    functionName: string | null;
    originalType: string;
    detail: LibSdbTypes.VariableDetailType | null;
    scope: AstScope;
    location: VariableLocation;
    isStateVariable: boolean;

    public static nextId: number = LibSdbConstants.ScopeTypes.variableStart.frame;

    constructor() {
        this.id = Variable.nextId++;
        this.isStateVariable = false;
    }

    childIds(): number[] {
        let ids: number[] = [];

        if (!(this.detail instanceof LibSdbTypes.ValueDetail) && this.detail !== null) {
            ids.push(this.detail.id);
            ids = ids.concat(this.detail.childIds());
        }

        return ids;
    }

    clone(): Variable {
        let clone = new Variable();

        clone.name = this.name;

        clone.position = this.position;

        clone.functionName = this.functionName;

        clone.originalType = this.originalType;

        clone.detail = this.detail === null ? null : this.detail.clone(clone);

        clone.scope = this.scope.clone();

        clone.location = this.location;

        clone.isStateVariable = this.isStateVariable;

        return clone;
    }

    typeToString(): string {
        return this.originalType;
    }

    variableReference(): number {
        if (this.detail instanceof LibSdbTypes.ValueDetail) {
            return 0;
        }
        else {
            return this.id;
        }
    }

    applyType(storageLocation: string, parentName: string, contractProcessor: ContractProcessor): void {
        const processor = new VariableProcessor(this, contractProcessor._currentStorageSlot, contractProcessor._currentStorageSlotOffset);
        processor.applyType(storageLocation, parentName);
        contractProcessor._currentStorageSlot = processor._currentStorageSlot;
        contractProcessor._currentStorageSlotOffset = processor._currentStorageSlotOffset;
    }
}