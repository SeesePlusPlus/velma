import { EventEmitter } from "events";
import { DebugProtocol } from "vscode-debugprotocol";

import { LibSdbTypes } from "./types/types";
import { LibSdbUtils } from "./utils/utils";
import { LibSdbInterface } from "./interface";
import { LibSdbBreakpoints } from "./breakpoints";
import { LibSdbEvaluator } from "./evaluator";
import { ValueDetail } from "./types/barrel";
import { LibSdbCompile } from "./compiler";

const CircularJSON = require("circular-json");

export class LibSdbRuntime extends EventEmitter {

    private static _instance: LibSdbRuntime;

    public _stepData: LibSdbTypes.StepData | null;

    public _priorStepData: LibSdbTypes.StepData | null;
    public _priorUiStepData: LibSdbTypes.StepData | null;

    public _callStack: LibSdbTypes.StackFrame[];
    public _priorUiCallStack: LibSdbTypes.StackFrame[] | null;

    public _ongoingEvaluation: LibSdbTypes.Evaluation | null;

    public _files: LibSdbTypes.FileMap;
    public _filesById: LibSdbTypes.FileByIdMap;
    public _contractsByName: LibSdbTypes.ContractMap;
    public _contractsByAddress: LibSdbTypes.ContractMap;

    public _variableReferenceIds: LibSdbTypes.VariableReferenceMap;

    public _interface: LibSdbInterface;
    public _breakpoints: LibSdbBreakpoints;
    public _evaluator: LibSdbEvaluator;
    public _compile: LibSdbCompile;

    constructor() {
        super();

        LibSdbRuntime._instance = this;

        this._interface = new LibSdbInterface();
        this._breakpoints = new LibSdbBreakpoints();
        this._evaluator = new LibSdbEvaluator();
        this._compile = new LibSdbCompile();

        this._files = new Map<string, LibSdbTypes.File>();
        this._filesById = new Map<number, LibSdbTypes.File>();
        this._contractsByName = new Map<string, LibSdbTypes.Contract>();
        this._contractsByAddress = new Map<string, LibSdbTypes.Contract>();

        this._variableReferenceIds = new Map<number, LibSdbTypes.ValueDetail | LibSdbTypes.ArrayDetail | LibSdbTypes.StructDetail | LibSdbTypes.MappingDetail>();

        this._stepData = null;
        this._priorStepData = null;
        this._priorUiStepData = null;

        this._callStack = [];
        this._priorUiCallStack = [];

        this._ongoingEvaluation = null;
    }

    public static instance(): LibSdbRuntime {
        return LibSdbRuntime._instance;
    }

    private respondToDebugHook(stepEvent: string, content: any = null) {
        // don't respond if we don't actually need to
        if (this._stepData === null) {
            return;
        }

        this._priorStepData = CircularJSON.parse(CircularJSON.stringify(this._stepData));

        this._interface.respondToDebugHook(stepEvent, this._stepData.debuggerMessageId, content);
    }

    private processJumpIn(sourceLocation: any, contract: LibSdbTypes.Contract, stack: any, isExternal: boolean = false) {
        // jump in

        if (this._priorStepData) {
            // push the prior function onto the stack. the current location for stack goes on when requested
            const nodePrior = LibSdbUtils.SourceMappingDecoder.findNodeAtSourceLocation("FunctionDefinition", this._priorStepData.source, { AST: contract.ast });
            const functionNamePrior = nodePrior === null ? "(anonymous function)" : nodePrior.attributes.name;
            let frame = new LibSdbTypes.StackFrame();
            frame.name = functionNamePrior;
            frame.file = contract.sourcePath;
            frame.line = this._priorStepData.location.start === null ? null : this._priorStepData.location.start.line;
            this._callStack.unshift(frame);
        }

        const node = LibSdbUtils.SourceMappingDecoder.findNodeAtSourceLocation("FunctionDefinition", sourceLocation, { AST: contract.ast });
        if (node !== null && node.children.length > 0 && node.children[0].name === "ParameterList") {
            const paramListNode = node.children[0];
            let numReturnVariables = 0;
            if (node.children.length > 1 && node.children[1].name === "ParameterList") {
                numReturnVariables = node.children[1].children.length;
            }
            for (let i = 0; i < paramListNode.children.length; i++) {
                const functionArgument = paramListNode.children[i];
                const variables = contract.scopeVariableMap.get(functionArgument.attributes.scope);
                if (variables) {
                    const variable = variables.get(functionArgument.attributes.name);
                    if (variable) {
                        variable.stackPosition = stack.length + i + (isExternal ? numReturnVariables : -paramListNode.children.length);
                    }
                }
            }
        }
    }

    private async processJumpOut(contract: LibSdbTypes.Contract, stack: any, memory: any): Promise<void> {
        // jump out, we should be at a JUMPDEST currently

        if (this._priorStepData) {
            const node = LibSdbUtils.SourceMappingDecoder.findNodeAtSourceLocation("FunctionDefinition", this._priorStepData.source, { AST: contract.ast });
            if (node !== null) {
                const functionName = node.attributes.name;
                if (this._ongoingEvaluation !== null && this._ongoingEvaluation.functionName === functionName) {
                    // get variable at top of stack
                    // TODO: add support for multiple variable evaluations

                    this._ongoingEvaluation.returnVariable.stackPosition = stack.length - 1;

                    let returnValue;
                    if (this._ongoingEvaluation.returnVariable.detail === null) {
                        returnValue = null;
                    }
                    else {
                        returnValue = await this._ongoingEvaluation.returnVariable.detail.decode(stack, memory, this._interface, this._ongoingEvaluation.contractAddress);
                    }
                    this._ongoingEvaluation.callback(returnValue);

                    this._ongoingEvaluation = null;
                }
            }
        }

        this._callStack.shift();
    }

    private processDeclaration(sourceLocation: any, contract: LibSdbTypes.Contract, stack: any) {
        // is there a variable declaration here?
        if (sourceLocation) {
            const variableDeclarationNode = LibSdbUtils.SourceMappingDecoder.findNodeAtSourceLocation("VariableDeclaration", sourceLocation, { AST: contract.ast });
            if (variableDeclarationNode) {
                const scope = variableDeclarationNode.attributes.scope;
                const variables = contract.scopeVariableMap.get(scope);
                if (variables) {
                    const names = variables.keys();
                    for (const name of names) {
                        if (name === variableDeclarationNode.attributes.name) {
                            let variable = variables.get(name)!;
                            if (variable.stackPosition === null) {
                                if (variable.location === LibSdbTypes.VariableLocation.Stack) {
                                    variable.stackPosition = stack.length;
                                }
                                else if (variable.location === LibSdbTypes.VariableLocation.Memory) {
                                    variable.stackPosition = stack.length;
                                }
                                if (variable.location === LibSdbTypes.VariableLocation.Storage) {
                                    variable.stackPosition = stack.length;
                                }
                                break;
                            }
                            else {
                                break;
                            }
                        }
                    }
                }
            }
        }
    }

    public async vmStepped(data: any): Promise<void> {
        this._stepData = null;
        const pc = data.content.pc;
        const address = data.content.address.toString("hex").toLowerCase();

        if (this._contractsByAddress.get(address) === undefined) {
            this._stepData = new LibSdbTypes.StepData();
            this._stepData.debuggerMessageId = data.id;
            this._stepData.source = null;
            this._stepData.location = null;
            this._stepData.contractAddress = address;
            this._stepData.vmData = data.content;
            this._stepData.scope = [];
            this._stepData.events = [];
            this.respondToDebugHook("stopOnBreakpoint");
        }
        else {
            const contract = this._contractsByAddress.get(address);

            if (!contract) {
                this.respondToDebugHook("skipEvent");
                return;
            }

            // get line number from pc
            const index = contract.pcMap.get(pc);
            const sourceLocation = LibSdbUtils.SourceMappingDecoder.atIndex(index, contract.srcmapRuntime);

            if (data.content.specialEvents.indexOf("fnJumpDestination") >= 0) {
                this.processJumpIn(sourceLocation, contract, data.content.stack, true);
            }
            else if (data.content.specialEvents.indexOf("jump") >= 0) {
                let processedJump: boolean = false;
                if (this._priorStepData && this._priorStepData.source) {
                    if (this._priorStepData.source.jump === "i") {
                        this.processJumpIn(sourceLocation, contract, data.content.stack);
                        processedJump = true;
                    }
                    else if (this._priorStepData.source.jump === "o") {
                        await this.processJumpOut(contract, data.content.stack, data.content.memory);
                        processedJump = true;
                    }
                }

                if (!processedJump && pc in contract.functionNames) {
                    // jump in to external function
                    // this is the JUMPDEST of a function we just entered
                    let frame = new LibSdbTypes.StackFrame();
                    frame.name = contract.functionNames[pc];
                    frame.file = contract.sourcePath;
                    frame.line = 0 //currentLocation.start === null ? null : currentLocation.start.line;
                    this._callStack.unshift(frame);
                }
            }
            else if (data.content.specialEvents.indexOf("declaration") >= 0) {
                this.processDeclaration(sourceLocation, contract, data.content.stack);
            }

            const fileId = parseInt(sourceLocation.file);
            let file: LibSdbTypes.File;
            if (!isNaN(fileId)) {
                file = this._filesById.get(fileId)!;
            }
            else {
                file = this._files.get(contract.sourcePath)!;
            }

            // find current scope
            const currentScope = LibSdbUtils.findScope(sourceLocation.start, contract.ast);

            let currentLocation = {
                start: null
            };
            if (file) {
                currentLocation = LibSdbUtils.SourceMappingDecoder.convertOffsetToLineColumn(sourceLocation, file.lineBreaks);
            }

            this._stepData = new LibSdbTypes.StepData();
            this._stepData.debuggerMessageId = data.id;
            this._stepData.source = sourceLocation;
            this._stepData.location = currentLocation;
            this._stepData.contractAddress = address;
            this._stepData.vmData = data.content;
            this._stepData.scope = currentScope;
            this._stepData.events = data.content.specialEvents;
            if (data.exceptionError !== undefined) {
                this._stepData.exception = data.exceptionError;
            }

            if (!file) {
                this.respondToDebugHook("skipEvent");
            }
            else if (data.content.specialEvents.length > 0 && data.content.specialEvents.indexOf("breakpoint") === -1 && data.exceptionError === undefined) {
                // if there were any special events, none of them were a breakpoint, and there was no exception, skip the event
                this.respondToDebugHook("skipEvent");
            }
            else {
                this.sendEvent("step");
            }
        }
    }

    public stack(startFrame: number, endFrame: number): any {
        const frames = new Array<any>();

        try {
            if (this._stepData !== null) {
                const contract = this._contractsByAddress.get(this._stepData.contractAddress)!;
                const fileId = parseInt(this._stepData.source.file);
                let file: LibSdbTypes.File;
                if (!isNaN(fileId)) {
                    file = this._filesById.get(fileId)!;
                }
                else {
                    file = this._files.get(contract.sourcePath)!;
                }
                const node = LibSdbUtils.SourceMappingDecoder.findNodeAtSourceLocation("FunctionDefinition", this._stepData.source, { AST: file.ast });
                if (startFrame === 0 && this._stepData.location && this._stepData.location.start) {
                    frames.push({
                        "index": startFrame,
                        "name": node === null ? "(anonymous function)" : node.attributes.name,
                        "file": file.fullPath(),
                        "line": LibSdbUtils.getOriginalLine(this._stepData.location.start.line, file.lineOffsets)
                    });
                }
            }

            for (let i = startFrame; i < Math.min(endFrame, this._callStack.length); i++) {
                frames.push({
                    "index": i + 1, // offset by one due to the current line "at the top of the stack", but not in the callstack variable
                    "name": this._callStack[i].name,
                    "file": this._callStack[i].file,
                    "line": LibSdbUtils.getOriginalLine(this._callStack[i].line, this._files.get(this._callStack[i].file)!.lineOffsets)
                });
            }
        }
        catch (e) {
            console.error(e);
        }

        return {
            frames: frames,
            count: frames.length
        };
    }

    public async variables(args: DebugProtocol.VariablesArguments): Promise<any[]> {
        let variables: any[] = [];

        if (this._stepData !== null) {
            const stack = this._stepData.vmData.stack;
            const memory = this._stepData.vmData.memory;
            const contract = this._contractsByAddress.get(this._stepData.contractAddress)!;

            if (args.variablesReference > 0 && args.variablesReference < 1000) {
                // TODO: get children for a variable
                if (this._variableReferenceIds.has(args.variablesReference)) {
                    const detail = this._variableReferenceIds.get(args.variablesReference)!;
                    if (!(detail instanceof ValueDetail)) {
                        variables = await detail.decodeChildren(stack, memory, this._interface, this._stepData.contractAddress);
                    }
                }
            }
            else {
                variables.push({
                    name: "Contract Address",
                    evaluateName: "Contract Address",
                    type: "string",
                    value: this._stepData.contractAddress,
                    variablesReference: 0
                });
                variables.push({
                    name: "Contract Name",
                    evaluateName: "Contract Name",
                    type: "string",
                    value: this._contractsByAddress.get(this._stepData.contractAddress)!.name,
                    variablesReference: 0
                });
                variables.push({
                    name: "Contract Code",
                    evaluateName: "Contract Code",
                    type: "string",
                    value: this._contractsByAddress.get(this._stepData.contractAddress)!.runtimeBytecode,
                    variablesReference: 0
                });
                variables.push({
                    name: "Program Counter",
                    evaluateName: "Program Counter",
                    type: "number",
                    value: this._stepData.vmData.pc + "",
                    variablesReference: 0
                });
                variables.push({
                    name: "Next OpCode",
                    evaluateName: "Next OpCode",
                    type: "string",
                    value: this._stepData.vmData.opcode.name,
                    variablesReference: 0
                });
                variables.push({
                    name: "Stack Length",
                    evaluateName: "Stack Length",
                    type: "number",
                    value: this._stepData.vmData.stack.length + "",
                    variablesReference: 0
                });

                for (let i = 0; i < this._stepData.scope.length; i++) {
                    const scope = this._stepData.scope[i];
                    if (contract.scopeVariableMap.has(scope.id)) {
                        const scopeVars = contract.scopeVariableMap.get(scope.id)!;
                        const names = scopeVars.keys();
                        for (const name of names) {
                            const variable = scopeVars.get(name);
                            if (variable && variable.detail !== null) {
                                const value = await variable.detail.decode(stack, memory, this._interface, this._stepData.contractAddress);

                                variables.push(value);
                            }
                        }
                    }
                }
            }
        }

        return variables;
    }

    public start(stopOnEntry: boolean) {
        this._breakpoints.verifyAllBreakpoints();

        if (stopOnEntry) {
            // we step once
            this.run(false, 'stopOnEntry');
        } else {
            // we just start to run until we hit a breakpoint or an exception
            this.continue();
        }
    }

    public continue(reverse = false, event = "stopOnBreakpoint") {
        this.run(reverse, event);
    }

    public stepOver(reverse = false, event = 'stopOnStepOver') {
        this.run(reverse, event);
    }

    public stepIn(reverse = false, event = 'stopOnStepIn') {
        this.run(reverse, event);
    }

    public stepOut(reverse = false, event = 'stopOnStepOut') {
        this.run(reverse, event);
    }

    private run(reverse = false, stepEvent: string, content: any = null): void {
        this._priorUiCallStack = CircularJSON.parse(CircularJSON.stringify(this._callStack));
        this._priorUiStepData = CircularJSON.parse(CircularJSON.stringify(this._stepData));

        // We should be stopped currently, which is why we're calling this function
        // so we should continue on now
        if (stepEvent !== "stopOnEvalBreakpoint") {
            this.respondToDebugHook(stepEvent, content);
        }

        if (reverse) {
            // TODO: implement reverse running
        } else {
            this.on("step", function handler(this: LibSdbRuntime) {
                if (this.fireEventsForStep(stepEvent)) {
                    // we've stopped for some reason. let's not continue
                    this.removeListener("step", handler);

                    // TODO: handle end of evm?
                    /*if (this.) {
                      // we've finished the evm
                      this._interface.sendEvent("end");
                    }*/
                }
                else {
                    // this is not the step we're looking for; move along
                    this.respondToDebugHook(stepEvent);
                }
            });
        }
    }

    private fireEventsForStep(stepEvent?: string): boolean {
        if (this._stepData === null || this._stepData.location === null || this._stepData.location.start === null) {
            return false;
        }

        const contract = this._contractsByAddress.get(this._stepData.contractAddress)!;
        const fileId = parseInt(this._stepData.source.file);
        let file: LibSdbTypes.File;
        if (!isNaN(fileId)) {
            file = this._filesById.get(fileId)!;
        }
        else {
            file = this._files.get(contract.sourcePath)!;
        }
        const ln = this._stepData.location.start.line;

        if (this._stepData.exception !== undefined) {
            this._interface.sendEvent("stopOnException");
            return true;
        }

        if (this._priorUiCallStack && this._priorUiStepData) {
            const callDepthChange = this._callStack.length - this._priorUiCallStack.length;
            const differentLine = ln !== this._priorUiStepData.location.start.line;
            const sameFile = this._stepData.source.file === this._priorUiStepData.source.file;
            switch (stepEvent) {
                case "stopOnStepOver":
                    if (callDepthChange === 0 && differentLine && sameFile) {
                        this._interface.sendEvent("stopOnStepOver");
                        return true;
                    }
                    break;
                case "stopOnStepIn":
                    const node = LibSdbUtils.SourceMappingDecoder.findNodeAtSourceLocation("FunctionDefinition", this._stepData.source, { AST: file.ast });
                    if (callDepthChange > 0 && (!sameFile || differentLine) && node !== null) {
                        this._interface.sendEvent("stopOnStepIn");
                        return true;
                    }
                    break;
                case "stopOnStepOut":
                    if (callDepthChange < 0 && (!sameFile || differentLine)) {
                        this._interface.sendEvent("stopOnStepOut");
                        return true;
                    }
                    break;
                default:
                    break;
            }
        }

        if (file !== undefined) {
            // is there a breakpoint?
            let differentLine: boolean = false;
            let sameFile: boolean = true;
            if (this._priorUiStepData) {
                differentLine = ln !== this._priorUiStepData.location.start.line;
                sameFile = this._stepData.source.file === this._priorUiStepData.source.file;
            }

            const bps = file.breakpoints.filter(bp => bp.line === ln && (this._priorUiStepData === null || !sameFile || differentLine) && ((bp.visible && stepEvent !== "stopOnEvalBreakpoint") || (!bp.visible && stepEvent === "stopOnEvalBreakpoint")));

            if (bps.length > 0) {
                // send 'stopped' event
                this._interface.sendEvent('stopOnBreakpoint');

                // the following shows the use of 'breakpoint' events to update properties of a breakpoint in the UI
                // if breakpoint is not yet verified, verify it now and send a 'breakpoint' update event
                if (!bps[0].verified) {
                    bps[0].verified = true;
                    this._interface.sendEvent('breakpointValidated', bps[0]);
                }

                // halt execution since we just hit a breakpoint
                return true;
            }
        }

        // nothing interesting found -> continue
        return false;
    }

    public async sendVariableDeclarations(address: string): Promise<void> {
        const contract = this._contractsByAddress.get(address);
        const declarations: number[] = [];
        if (contract) {
            let indexMap = new Map<number, number>();
            for (const entry of contract.pcMap.entries()) {
                indexMap.set(entry[1], entry[0]);
            }
            const astWalker = new LibSdbUtils.AstWalker();
            astWalker.walk(contract.ast, (node) => {
                if (node.name === "VariableDeclaration" && node.src) {
                    const srcSplit = node.src.split(":");
                    const sourceLocation = {
                        start: parseInt(srcSplit[0]),
                        length: parseInt(srcSplit[1]),
                        file: parseInt(srcSplit[2])
                    };
                    const index = LibSdbUtils.SourceMappingDecoder.toIndex(sourceLocation, contract.srcmapRuntime);
                    if (index !== null) {
                        const pc = indexMap.get(index);
                        if (pc !== undefined) {
                            declarations.push(pc);
                        }
                    }

                    return false;
                }

                return true;
            });
            if (declarations.length > 0) {
                await this._interface.requestSendVariableDeclarations(address, declarations);
            }
        }
    }

    public async sendFunctionJumpDestinations(address: string): Promise<void> {
        const contract = this._contractsByAddress.get(address);
        const jumpDestinations: number[] = [];
        if (contract) {
            let indexMap = new Map<number, number>();
            for (const entry of contract.pcMap.entries()) {
                indexMap.set(entry[1], entry[0]);
            }
            const astWalker = new LibSdbUtils.AstWalker();
            astWalker.walk(contract.ast, (node) => {
                if (node.name === "FunctionDefinition" && node.src) {
                    const srcSplit = node.src.split(":");
                    const sourceLocation = {
                        start: parseInt(srcSplit[0]),
                        length: parseInt(srcSplit[1]),
                        file: parseInt(srcSplit[2])
                    };
                    const index = LibSdbUtils.SourceMappingDecoder.toIndex(sourceLocation, contract.srcmapRuntime);
                    if (index !== null) {
                        const pc = indexMap.get(index);
                        if (pc !== undefined) {
                            jumpDestinations.push(pc);
                        }
                    }

                    return false;
                }

                return true;
            });
            if (jumpDestinations.length > 0) {
                await this._interface.requestSendFunctionJumpDestinations(address, jumpDestinations);
            }
        }
    }

    public sendEvent(event: string, ...args: any[]) {
        setImmediate(_ => {
            this.emit(event, ...args);
        });
    }
}