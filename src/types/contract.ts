import { ScopeVariableMap, Ast, VariableMap } from "./misc";
import { Variable } from "./variable/variable";
import { LibSdbTypes } from "./types";

const CircularJSON = require("circular-json");

export class ContractBytecode {
    code: string;
    srcMap: string;
    pcMap: Map<number, LibSdbTypes.EvmInstruction>;
    breakpoints: Map<number, number>;

    constructor() {
        this.pcMap = new Map<number, LibSdbTypes.EvmInstruction>();
        this.breakpoints = new Map<number, number>();
    }

    clone(): ContractBytecode {
        let clone = new ContractBytecode();

        for (const v of this.pcMap) {
            clone.pcMap.set(v[0], v[1]);
        }

        clone.code = this.code;

        clone.srcMap = this.srcMap;

        for (const v of this.breakpoints) {
            clone.breakpoints.set(v[0], v[1]);
        }

        return clone;
    }
}

export class Contract {
    name: string;
    sourcePath: string;
    addresses: string[];
    scopeVariableMap: ScopeVariableMap;
    functionNames: Map<number, string>; // key: pc, value: hash
    creationBytecode: ContractBytecode;
    runtimeBytecode: ContractBytecode;
    ast: Ast;
    stateVariables: Variable[];
    structDefinitions: Map<string, LibSdbTypes.VariableMap>;
    enumDefinitions: Map<string, LibSdbTypes.EnumDefinition>;
    inheritedContracts: Contract[];

    constructor() {
        this.scopeVariableMap = new Map<number, VariableMap>();
        this.functionNames = new Map<number, string>();
        this.creationBytecode = new ContractBytecode();
        this.runtimeBytecode = new ContractBytecode();
        this.stateVariables = [];
        this.addresses = [];
        this.structDefinitions = new Map<string, Map<string, Variable>>();
        this.enumDefinitions = new Map<string, LibSdbTypes.EnumDefinition>();
        this.inheritedContracts = [];
    }

    clone(): Contract {
        let clone = new Contract();

        clone.name = this.name;

        clone.sourcePath = this.sourcePath;

        clone.addresses = JSON.parse(JSON.stringify(this.addresses));

        for (const variables of this.scopeVariableMap) {
            const variablesClone = new Map<string, Variable>();
            for (const variable of variables[1]) {
                variablesClone.set(variable[0], variable[1].clone());
            }
            clone.scopeVariableMap.set(variables[0], variablesClone);
        }

        for (const v of this.functionNames) {
            clone.functionNames.set(v[0], v[1]);
        }

        clone.creationBytecode = this.creationBytecode.clone();

        clone.runtimeBytecode = this.runtimeBytecode.clone();

        clone.ast = CircularJSON.parse(CircularJSON.stringify(this.ast));

        for (let i = 0; i < this.stateVariables.length; i++) {
            clone.stateVariables.push(this.stateVariables[i]);
        }

        for (const v of this.structDefinitions) {
            let definitionClone: LibSdbTypes.VariableMap = new Map<string, Variable>();

            for (const v2 of v[1]) {
                definitionClone.set(v2[0], v2[1].clone());
            }

            clone.structDefinitions.set(v[0], definitionClone);
        }

        for (const v of this.enumDefinitions) {
            clone.enumDefinitions.set(v[0], v[1].clone());
        }

        for (let i = 0; i < this.inheritedContracts.length; i++) {
            clone.inheritedContracts.push(this.inheritedContracts[i]);
        }

        return clone;
    }
}