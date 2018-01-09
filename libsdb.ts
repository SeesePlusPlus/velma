import { readFileSync } from "fs";
import { EventEmitter } from "events";
import { Socket } from "net";
import { util, code } from "/home/mike/projects/remix/src/index";
import { compile } from "solc";
import { v4 as uuidv4 } from "uuid";

const CircularJSON = require("circular-json");
const BigNumber = require("bignumber.js");
const traverse = require("traverse");
const parseExpression = require("/home/mike/projects/solidity-parser/index").parse;
const sourceMappingDecoder = new util.SourceMappingDecoder();

// bytecode is a hex string of the bytecode without the preceding '0x'
// methodId is the SHA3 hash of the ABI for this function
// returns the first occurence of the following bytecode sequence:
// DUP1, PUSH4 methodId, EQ, PUSH1 pc
// TODO: this could maybe not work depending on the different compiler optimization levels
export function GetFunctionProgramCount(bytecode, methodId) {
  const bytecodeSequence = "63" + methodId + "1460";
  const pos = bytecode.indexOf(bytecodeSequence);
  if (pos < 0) {
    return null;
  }
  else {
    const pc = bytecode[pos + bytecodeSequence.length] + bytecode[pos + bytecodeSequence.length + 1];
    return parseInt(pc, 16);
  }
}

export interface SdbStepData {
  debuggerMessageId: any;
  source: any;
  location: any;
  contractAddress: string;
  vmData: any;
  scope: SdbAstScope[];
}

export interface SdbBreakpoint {
  id: number;
  line: number;
  verified: boolean;
  visible: boolean;
  originalSource: boolean;
}

export interface SdbStackFrame {
  name: string;
  file: string;
  line: number;
  pc: number;
}

export interface SdbAstScope {
  id: number; // id provided by compiler
  childIndex: number | null; // index in parent's 'children' array, null if root node
  depth: number;
}

export interface SdbVariable {
  name: string;
  type: string;
  scope: SdbAstScope;
  stackPosition: number | null;
}

export interface SdbExpressionFunction {
  name: string;
  args: SdbVariable[];
  argsString: string;
  reference: string;
  code: string;
}

export interface SdbEvaluation {
  functionName: string;
  callback: Function;
}

function adjustBreakpointLineNumbers(breakpoints: Map<string, SdbBreakpoint[]>, path: string, startLine: number, numLines: number): void {
  let bps = breakpoints.get(path);
  if (bps) {
    for (let i = 0; i < bps.length; i++) {
      if (bps[i].line >= startLine) {
        bps[i].line += numLines;
      }
    }
  }
};

function adjustCallstackLineNumbers(callstack: SdbStackFrame[], path: string, startLine: number, numLines: number): void {
  // TODO: should we modify the PC as well? probably
  for (let i = 0; i < callstack.length; i++) {
    if (callstack[i].file === path && callstack[i].line >= startLine) {
      callstack[i].line += numLines;
    }
  }
};

/** Parse the error message thrown with a naive compile in order to determine the actual return type. This is the hacky alternative to parsing an AST. */
const regexpReturnError = /Return argument type (.*) is not implicitly convertible to expected type \(type of first return variable\) bool./
const matchReturnTypeFromError = message => message.match(regexpReturnError);

export class LibSdb extends EventEmitter {

  // maps from sourceFile to array of Mock breakpoints
  private _breakPoints: Map<string, SdbBreakpoint[]>;

  // since we want to send breakpoint events, we will assign an id to every event
  // so that the frontend can match events with breakpoints.
  private _breakpointId: number;

  private _socket: Socket;

  private _compilationResult: any;

  private _stepData: SdbStepData | null;

  private _priorStepData: SdbStepData | null;
  private _priorUiStepData: SdbStepData | null;

  private _callStack: SdbStackFrame[];
  private _priorUiCallStack: SdbStackFrame[] | null;

  private _variables: Map<number, Map<string, SdbVariable>>;

  private _lineOffsets: Map<number, number>;

  private _ongoingEvaluation: SdbEvaluation | null;

  constructor() {
    super();
    this._stepData = null;
    this._socket = new Socket();
    this._breakPoints = new Map<string, SdbBreakpoint[]>();
    this._breakpointId = 1;
    this._priorStepData = null;
    this._callStack = [];
    this._priorUiCallStack = [];
    this._priorUiStepData = null;
    this._variables = new Map<number, Map<string, SdbVariable>>();
    this._lineOffsets = new Map<number, number>();
    this._ongoingEvaluation = null;
  }
  
  private contractsChanged(data: any) {
    // addresses changed
    this._compilationResult = data.content;
    this.sendEvent("solidityProxyLoaded");
    
    let contracts = this._compilationResult.contracts;
    Object.keys(contracts).forEach((key) => {
      if(contracts[key].sourcePath !== null) {
        contracts[key].pcMap = code.util.nameOpCodes(new Buffer(contracts[key].runtimeBytecode, 'hex'))[1];

        contracts[key].sourceCode = readFileSync(contracts[key].sourcePath, "utf8");
        contracts[key].lineBreaks = sourceMappingDecoder.getLinebreakPositions(contracts[key].sourceCode);

        contracts[key].functionNames = {};
        Object.keys(contracts[key].functionHashes).forEach((functionName) => {
          const pc = GetFunctionProgramCount(contracts[key].runtimeBytecode, contracts[key].functionHashes[functionName]);
          if (pc !== null) {
            contracts[key].functionNames[pc] = functionName;
          }
        });
      }
    });

    const astWalker = new util.AstWalker();
    astWalker.walkDetail(this._compilationResult.sources["DebugContract.sol"].AST, null, 0, (node, parent, depth) => {
      if (node.id) {
        // this is a new scope, add to map
        this._variables.set(node.id, new Map<string, SdbVariable>());

        if (node.name === "VariableDeclaration") {
          let childIndex: number | null = null;
          if (parent) {
            // look for the child in the parent to get the index
            for (let i = 0; i < parent.children.length; i++) {
              if (parent.children[i].id === node.id) {
                childIndex = i;
              }
            }
          }

          const variable = <SdbVariable> {
            name: node.attributes.name,
            type: node.attributes.type,
            scope: <SdbAstScope> {
              id: node.attributes.scope,
              childIndex: childIndex,
              depth: depth
            },
            stackPosition: null
          };

          // add the variable to the parent's scope
          this._variables.get(variable.scope.id)!.set(variable.name, variable);
        }
      }

      return true;
    });
    
    const response = {
      "status": "ok",
      "id": data.id,
      "messageType": "response",
      "content": null
    };
    this._socket.write(CircularJSON.stringify(response));
  }

  private findScope(index: number): SdbAstScope[] {
    let scope: SdbAstScope[] = [];
    const ast = this._compilationResult.sources["DebugContract.sol"].AST;

    const astWalker = new util.AstWalker();
    astWalker.walkDetail(ast, null, 0, (node, parent, depth) => {
      const src = node.src.split(":").map((s) => { return parseInt(s); });
      if (src.length >= 2 && src[0] <= index && index <= src[0] + src[1]) {
        let childIndex: number | null = null;
        if (parent) {
          // look for the child in the parent to get the index
          for (let i = 0; i < parent.children.length; i++) {
            if (parent.children[i].id === node.id) {
              childIndex = i;
            }
          }
        }
        scope.unshift(<SdbAstScope> {
          id: node.id,
          childIndex: childIndex,
          depth: depth
        });
        return true;
      }
      else {
        return false;
      }
    });

    return scope;
  }

  private vmStepped(data: any) {
    // step through code
    const pc = data.content.pc;
    const address = (new Buffer(data.content.address.data)).toString("hex");
    
    /*if (!(address in this._contracts)) {
      console.log("address " + address + " not monitored");
      const response = {
        "status": "error",
        "id": data.id,
        "messageType": "response",
        "content": "address not monitored"
      };
      this._socket.write(CircularJSON.stringify(response));
      return;
    }*/

    if(typeof this._compilationResult === "undefined" || typeof this._compilationResult.contracts === "undefined") {
      this._stepData = <SdbStepData> {
        debuggerMessageId: data.id,
        source: null,
        location: null,
        contractAddress: address,
        vmData: data.content,
        scope: []
      };
      this.respondToDebugHook();
    }
    else {
      const contract = this._compilationResult.contracts[this._compilationResult.contractMap[address]];

      // get line number from pc
      const index = contract.pcMap[pc];
      const sourceLocation = sourceMappingDecoder.atIndex(index, contract.srcmapRuntime);
      const currentLocation = sourceMappingDecoder.convertOffsetToLineColumn(sourceLocation, contract.lineBreaks);

      if (this._priorStepData && this._priorStepData.source) {
        if (this._priorStepData.source.jump === "i") {
          // jump in

          // push the prior function onto the stack. the current location for stack goes on when requested
          const node = sourceMappingDecoder.findNodeAtSourceLocation("FunctionDefinition", this._priorStepData.source, this._compilationResult.sources["DebugContract.sol"]);
          const functionName = node.attributes.name;
          const frame = <SdbStackFrame> {
            name: functionName,
            file: contract.sourcePath,
            line: this._priorStepData.location.start === null ? null : this._priorStepData.location.start.line,
            pc: pc
          };
          this._callStack.unshift(frame);
        }
        else if (this._priorStepData.source.jump === "o") {
          // jump out, we should be at a JUMPDEST currently
          const node = sourceMappingDecoder.findNodeAtSourceLocation("FunctionDefinition", this._priorStepData.source, this._compilationResult.sources["DebugContract.sol"]);
          const functionName = node.attributes.name;
          if (this._ongoingEvaluation !== null && this._ongoingEvaluation.functionName === functionName) {
            // get variable at top of stack
            // TODO: add support for multiple variable evaluations

            const buf = new Buffer(data.content.stack[data.content.stack.length - 1].data);
            const num = new BigNumber("0x" + buf.toString("hex"));

            this._ongoingEvaluation.callback(num.toString());

            this._ongoingEvaluation = null;
          }

          this._callStack.shift();
        }
        else if (pc in contract.functionNames) {
          // jump in to external function
          // this is the JUMPDEST of a function we just entered mike is cute

          // TODO: figure this out
          // const functionName = contract.functionNames[pc];
          const frame = <SdbStackFrame> {
            name: "external place?",
            file: contract.sourcePath,
            line: 0, //currentLocation.start === null ? null : currentLocation.start.line,
            pc: pc
          };
          this._callStack.unshift(frame);
        }
      }

      // find current scope
      const currentScope = this.findScope(sourceLocation.start);

      // is there a variable declaration here?
      if (sourceLocation) {
        const variableDeclarationNode = sourceMappingDecoder.findNodeAtSourceLocation("VariableDeclaration", sourceLocation, this._compilationResult.sources["DebugContract.sol"]);
        if (variableDeclarationNode) {
          const scope = variableDeclarationNode.attributes.scope;
          const variables = this._variables.get(scope);
          if (variables) {
            const names = variables.keys();
            for (const name of names) {
              if (name === variableDeclarationNode.attributes.name) {
                variables.get(name)!.stackPosition = data.content.stack.length
                break;
              }
            }
          }
        }
      }

      this._stepData = <SdbStepData> {
        debuggerMessageId: data.id,
        source: sourceLocation,
        location: currentLocation,
        contractAddress: address,
        vmData: data.content,
        scope: currentScope
      };

      this.sendEvent("step");
    }
  }

  private socketHandler(dataSerialized: string) {
    const data = CircularJSON.parse(dataSerialized);
    const triggerType = data.triggerType;
    const messageType = data.messageType;
  
    if (triggerType === "monitoredContractsChanged") {
      this.contractsChanged(data);
    }
    else if (triggerType === "step") {
      this.vmStepped(data);
    }
    else if (messageType === "response") {
      if (data.content && data.content.type === "putCodeResponse") {
        // i guess we dont care right now that this is responding to the specific request yet; we will probably eventually
        this.respondToDebugHook(); // eek, let the debugger run!
      }
    }
  }

  /**
   * Attach to SDB hook which interfaces to the EVM
   */
  public attach(host: string, port: number, callback) {
    this._socket.on('error', function(this: LibSdb, e) {
      if(e.code === 'ECONNREFUSED') {
        console.log('Is the server running at ' + port + '?');

        this._socket.setTimeout(5000, function(this: LibSdb) {
          this._socket.connect(port, host, function(){
            callback();
          });
        }.bind(this));

        console.log('Timeout for 5 seconds before trying port:' + port + ' again');

      }
    }.bind(this));

    this._socket.connect(port, host, () => {
      callback();
    });

    this._socket.on("data", this.socketHandler.bind(this));
  }

  /**
   * Start executing the given program.
   */
  public start(stopOnEntry: boolean) {

    this.verifyAllBreakpoints();

    if (stopOnEntry) {
      // we step once
      this.run(false, 'stopOnEntry');
    } else {
      // we just start to run until we hit a breakpoint or an exception
      this.continue();
    }
  }

  /**
   * Continue execution to the end/beginning.
   */
  public continue(reverse = false) {
    this.run(reverse, undefined);
  }

  /**
   * Step to the next/previous non empty line.
   */
  public stepOver(reverse = false, event = 'stopOnStepOver') {
    this.run(reverse, event);
  }

  public stepIn(reverse = false, event = 'stopOnStepIn') {
    this.run(reverse, event);
  }
  
  public stepOut(reverse = false, event = 'stopOnStepOut') {
    this.run(reverse, event);
  }

  /**
   * Returns a fake 'stacktrace' where every 'stackframe' is a word from the current line.
   */
  public stack(startFrame: number, endFrame: number): any {
    const frames = new Array<any>();

    if (this._stepData !== null) {
      const node = sourceMappingDecoder.findNodeAtSourceLocation("FunctionDefinition", this._stepData.source, this._compilationResult.sources["DebugContract.sol"]);
      const functionName = node.attributes.name;
      if (startFrame === 0 && this._stepData.location && this._stepData.location.start) {
        frames.push({
          "index": startFrame,
          "name": functionName,
          "file": this._compilationResult.contracts["DebugContract.sol:DebugContract"].sourcePath,
          "line": this.getOriginalLine(this._stepData.location.start.line)
        });
      }
    }

    for (let i = startFrame; i < Math.min(endFrame, this._callStack.length); i++) {
      frames.push({
        "index": i + 1, // offset by one due to the current line "at the top of the stack", but not in the callstack variable
        "name": this._callStack[i].name,
        "file": this._callStack[i].file,
        "line": this.getOriginalLine(this._callStack[i].line)
      });
    }

    return {
      frames: frames,
      count: frames.length
    };
  }

  public variables(): any[] {
    let variables: any[] = [];

    if (this._stepData !== null) {
      const stack = this._stepData.vmData.stack;
      for (let i = 0; i < this._stepData.scope.length; i++) {
        const scope = this._stepData.scope[i];
        const scopeVars = this._variables.get(scope.id)!;
        const names = scopeVars.keys();
        for (const name of names) {
          const variable = scopeVars.get(name);
          if (variable && variable.stackPosition !== null && stack.length > variable.stackPosition) {
            const buf = new Buffer(stack[variable.stackPosition].data);
            const num = new BigNumber("0x" + buf.toString("hex"));
            variables.push({
              name: name,
              type: variable.type,
              value: num.toString(),
              variablesReference: 0
            });
          }
        }
      }
    }

    return variables;
  }

  /*
   * Set breakpoint in file with given line.
   */
  public setBreakPoint(path: string, line: number, visible: boolean = true, originalSource: boolean = true) : SdbBreakpoint {
    if (originalSource) {
      // we need to modify the line number using line offsets with the original source bp's
      line = this.getNewLine(line);
    }

    const bp = <SdbBreakpoint> { verified: false, line, id: this._breakpointId++, visible: visible, originalSource: originalSource };
    let bps = this._breakPoints.get(path);
    if (!bps) {
      bps = new Array<SdbBreakpoint>();
      this._breakPoints.set(path, bps);
    }
    if (bps.indexOf(bp) === -1) {
      bps.push(bp);
    }

    this.verifyBreakpoints(path);

    return bp;
  }

  /*
   * Clear breakpoint in file with given line.
   */
  public clearBreakPoint(path: string, line: number) : SdbBreakpoint | undefined {
    let bps = this._breakPoints.get(path);
    if (bps) {
      const index = bps.findIndex(bp => bp.line === line);
      if (index >= 0) {
        const bp = bps[index];
        bps.splice(index, 1);
        return bp;
      }
    }
    return undefined;
  }

  /*
   * Clear all breakpoints for file.
   */
  public clearBreakpoints(path: string): void {
    this._breakPoints.delete(path);
  }

  // private methods

  /**
   * Run through the file.
   * If stepEvent is specified only run a single step and emit the stepEvent.
   */
  private run(reverse = false, stepEvent?: string, content: any = null) : void {
    this._priorUiCallStack = CircularJSON.parse(CircularJSON.stringify(this._callStack));
    this._priorUiStepData = CircularJSON.parse(CircularJSON.stringify(this._stepData));

    // We should be stopped currently, which is why we're calling this function
    // so we should continue on now
    this.respondToDebugHook(content);

    if (reverse) {
      // TODO: implement reverse running

      /*for (let ln = this._currentLine-1; ln >= 0; ln--) {
        if (this.fireEventsForLine(ln, stepEvent)) {
          this._currentLine = ln;
          return;
        }
      }
      // no more lines: stop at first line
      this._currentLine = 0;
      this.sendEvent('stopOnEntry');*/
    } else {
      this.on("step", function handler(this: LibSdb) {
        if (this.fireEventsForStep(stepEvent)) {
          // we've stopped for some reason. let's not continue
          this.removeListener("step", handler);

          // TODO: handle end of evm?
          /*if (this.) {
            // we've finished the evm
            this.sendEvent("end");
          }*/
        }
        else {
          // this is not the step we're looking for; move along
          this.respondToDebugHook();
        }
      });
    }
  }

  private respondToDebugHook(content: any = null) {
    // don't respond if we don't actually need to
    if (this._stepData === null) {
      return;
    }

    this._priorStepData = CircularJSON.parse(CircularJSON.stringify(this._stepData));

    const response = {
      "status": "ok",
      "id": this._stepData.debuggerMessageId,
      "messageType": "response",
      "content": content
    };
    this._socket.write(CircularJSON.stringify(response));
    this._stepData = null;
  }
  
  private verifyAllBreakpoints() : void {
    this._breakPoints.forEach((bps, path) => {
      this.verifyBreakpoints(path);
    })
  }

  private verifyBreakpoints(path: string) : void {
    let bps = this._breakPoints.get(path);
    if (bps) {
      bps.forEach(bp => {
        // Temporarily validate each breakpoint
        bp.verified = true;
        this.sendEvent('breakpointValidated', bp);

        // TODO: real breakpoint verification
        /*if (!bp.verified && bp.line < this._sourceLines.length) {
          const srcLine = this._sourceLines[bp.line].trim();

          // if a line is empty or starts with '+' we don't allow to set a breakpoint but move the breakpoint down
          if (srcLine.length === 0 || srcLine.indexOf('+') === 0) {
            bp.line++;
          }
          // if a line starts with '-' we don't allow to set a breakpoint but move the breakpoint up
          if (srcLine.indexOf('-') === 0) {
            bp.line--;
          }
          // don't set 'verified' to true if the line contains the word 'lazy'
          // in this case the breakpoint will be verified 'lazy' after hitting it once.
          if (srcLine.indexOf('lazy') < 0) {
            bp.verified = true;
            this.sendEvent('breakpointValidated', bp);
          }
        }*/
      });
    }
  }

  /**
   * Fire events if line has a breakpoint or the word 'exception' is found.
   * Returns true is execution needs to stop.
   */
  private fireEventsForStep(stepEvent?: string): boolean {
    if(this._stepData === null || this._stepData.location === null || this._stepData.location.start === null) {
      return false;
    }

    const ln = this._stepData.location.start.line;
    console.log(this._stepData.vmData.pc + " - " + ln + " - " + JSON.stringify(this._stepData.vmData.opcode));

    if (this._priorUiCallStack && this._priorUiStepData) {
      const callDepthChange = this._callStack.length - this._priorUiCallStack.length;
      const differentLine = ln !== this._priorUiStepData.location.start.line;
      switch (stepEvent) {
        case "stopOnStepOver":
          if (callDepthChange === 0 && differentLine) {
            this.sendEvent("stopOnStepOver");
            return true;
          }
          break;
        case "stopOnStepIn":
          const node = sourceMappingDecoder.findNodeAtSourceLocation("FunctionDefinition", this._stepData.source, this._compilationResult.sources["DebugContract.sol"]);
          if (callDepthChange > 0 && differentLine && node === null) {
            this.sendEvent("stopOnStepIn");
            return true;
          }
          break;
        case "stopOnStepOut":
          if (callDepthChange < 0 && differentLine) {
            this.sendEvent("stopOnStepOut");
            return true;
          }
          break;
        default:
          break;
      }
    }

    // TODO: do we need to do an output event send?
    // this.sendEvent('output', matches[1], this._sourceFile, ln, matches.index)

    // TODO: figure out if an exception happened? do exceptions happen in the VM?
    /*if (line.indexOf('exception') >= 0) {
      this.sendEvent('stopOnException');
      return true;
    }*/

    // TODO: Stop on out of gas. I'd call that an exception

    // is there a breakpoint?
    const breakpoints = this._breakPoints.get(this._compilationResult.contracts[this._compilationResult.contractMap[this._stepData.contractAddress]].sourcePath);
    if (breakpoints) {
      let priorLine = null;
      if (this._priorUiStepData && this._priorUiStepData.location.start) {
        priorLine = this._priorUiStepData.location.start.line;
      }
      const bps = breakpoints.filter(bp => bp.line === ln && (priorLine === null || ln !== priorLine));
      if (bps.length > 0) {

        // send 'stopped' event
        this.sendEvent('stopOnBreakpoint');

        // the following shows the use of 'breakpoint' events to update properties of a breakpoint in the UI
        // if breakpoint is not yet verified, verify it now and send a 'breakpoint' update event
        if (!bps[0].verified) {
          bps[0].verified = true;
          this.sendEvent('breakpointValidated', bps[0]);
        }
        return true;
      }
    }

    // nothing interesting found -> continue
    return false;
  }

  private findArguments(frameId: number | undefined, expression: string): SdbVariable[] {
    let variables: SdbVariable[] = [];

    if (this._stepData !== null) {
      const result = parseExpression(expression, "solidity-expression");

      let identifiers = traverse(result.body).reduce((acc, x) => {
        if (typeof x === "object" && "type" in x && x.type === "Identifier") {
          acc.push(x);
        }
        return acc;
      });
      identifiers.shift(); // TODO: remove root node?

      let allVariables: Map<string, SdbVariable> = new Map<string, SdbVariable>();
      for (let i = 0; i < this._stepData.scope.length; i++) {
        const scope = this._stepData.scope[i];
        const scopeVars = this._variables.get(scope.id)!;
        const names = scopeVars.keys();
        for (const name of names) {
          const variable = scopeVars.get(name);
          if (variable && variable.stackPosition !== null) {
            allVariables.set(name, variable);
          }
        }
      }

      for (let i = 0; i < identifiers.length; i++) {
        if (allVariables.has(identifiers[i].name)) {
          variables.push(allVariables.get(identifiers[i].name)!);
        }
        else {
          // woah, we don't know that identifier/variable. error?
        }
      }
    }

    return variables;
  }

  private generateFunction(expression: string, args: SdbVariable[]): SdbExpressionFunction {
    const functionName: string = "sdb_" + uuidv4().replace(/-/g, "");
    
    const argsString = args.map((arg) => {
      return arg.type + " " + arg.name;
    }).join(",");
    
    const argsRefString = args.map((arg) => {
      return arg.name;
    }).join(",");

    const functionReference = functionName + "(" + argsRefString + ");";

    const functionCode: string =
`
function ` + functionName + `(` + argsString + `) returns (bool) {
  return ` + expression + `
}

`

    let expressionFunction = <SdbExpressionFunction> {
      name: functionName,
      reference: functionReference,
      args: args,
      argsString: argsString,
      code: functionCode
    };

    return expressionFunction;
  }

  public evaluate(expression: string, context: string | undefined, frameId: number | undefined, callback) {
    if (this._stepData === null) {
      return;
    }

    if (context === "hover") {
      // TODO: implement this
      return;
    }

    if (this._ongoingEvaluation !== null) {
      // TODO: improve this
      return;
    }

    expression = expression + (expression.endsWith(';') ? '' : ';');
    const contractKey = this._compilationResult.contractMap[this._stepData.contractAddress];
    let contractName = contractKey.split(":");
    contractName = contractName[contractName.length - 1];
    let contract = this._compilationResult.contracts[contractKey];
    let newContract = CircularJSON.parse(CircularJSON.stringify(contract));

    const functionArgs = this.findArguments(frameId, expression);
    const functionInsert = this.generateFunction(expression, functionArgs);

    let newLineOffsets = new Map<number, number>();
    this._lineOffsets.forEach((value: number, key: number) => {
      newLineOffsets.set(key, value);
    });

    let newBreakpoints: Map<string, SdbBreakpoint[]> = new Map<string, SdbBreakpoint[]>();
    this._breakPoints.forEach((values: SdbBreakpoint[], key: string) => {
      let copyValues: SdbBreakpoint[] = [];
      for (let i = 0; i < values.length; i++) {
        let copyValue = <SdbBreakpoint> { id: values[i].id, line: values[i].line, verified: values[i].verified, visible: values[i].visible };
        copyValues.push(copyValue);
      }
      newBreakpoints.set(key, copyValues);
    });

    let newCallstack: SdbStackFrame[] = [];
    for (let i = 0; i < this._callStack.length; i++) {
      let copyValue = <SdbStackFrame> { file: this._callStack[i].file, line: this._callStack[i].line, name: this._callStack[i].name, pc: this._callStack[i].pc };
      newCallstack.push(copyValue);
    }

    let newPriorUiCallstack: SdbStackFrame[] | null;
    if (this._priorUiCallStack === null) {
      newPriorUiCallstack = null;
    }
    else {
      newPriorUiCallstack = [];
      for (let i = 0; i < this._priorUiCallStack.length; i++) {
        let copyValue = <SdbStackFrame> { file: this._priorUiCallStack[i].file, line: this._priorUiCallStack[i].line, name: this._priorUiCallStack[i].name, pc: this._priorUiCallStack[i].pc };
        newPriorUiCallstack.push(copyValue);
      }
    }

    if (this._stepData !== null && this._stepData.location !== null && this._stepData.location.start !== null) {
      const currentLine = this._stepData.location.start.line;
      if (currentLine > 0) {
        const insertPosition = newContract.lineBreaks[currentLine - 1] + 1;

        newContract.sourceCode = [newContract.sourceCode.slice(0, insertPosition), functionInsert.reference + "\n", newContract.sourceCode.slice(insertPosition)].join('');
        newContract.lineBreaks = sourceMappingDecoder.getLinebreakPositions(newContract.sourceCode);

        // Adjust line numbers
        this.addLineOffset(currentLine, 1, newLineOffsets);
        adjustBreakpointLineNumbers(newBreakpoints, newContract.sourcePath, currentLine, 1);
        adjustCallstackLineNumbers(newCallstack, newContract.sourcePath, currentLine, 1);
        if (newPriorUiCallstack !== null) {
          adjustCallstackLineNumbers(newPriorUiCallstack, newContract.sourcePath, currentLine, 1);
        }

        const contractDeclarationPosition = newContract.sourceCode.indexOf("contract " + contractName);
        let functionInsertPosition: number | null = null;
        let functionInsertLine: number | null = null;
        for (let i = 0; i < newContract.lineBreaks.length; i++) {
          if (newContract.lineBreaks[i] > contractDeclarationPosition) {
            functionInsertLine = i + 1;
            functionInsertPosition = newContract.lineBreaks[i] + 1;
            break;
          }
        }

        if (functionInsertPosition !== null && functionInsertLine !== null) {
          newContract.sourceCode = [newContract.sourceCode.slice(0, functionInsertPosition), functionInsert.code, newContract.sourceCode.slice(functionInsertPosition)].join('');
          newContract.lineBreaks = sourceMappingDecoder.getLinebreakPositions(newContract.sourceCode);

          // Adjust line numbers
          const numNewLines = (functionInsert.code.match(/\n/g) || []).length;
          this.addLineOffset(functionInsertLine, numNewLines, newLineOffsets);
          adjustBreakpointLineNumbers(newBreakpoints, newContract.sourcePath, functionInsertLine, numNewLines);
          adjustCallstackLineNumbers(newCallstack, newContract.sourcePath, functionInsertLine, numNewLines);
          if (newPriorUiCallstack !== null) {
            adjustCallstackLineNumbers(newPriorUiCallstack, newContract.sourcePath, functionInsertLine, numNewLines);
          }

          let result = compile(newContract.sourceCode, 0);
          for (let i = 0; i < result.errors.length; i++) {
            const error = result.errors[i];
            let match = matchReturnTypeFromError(error);
            if (match) {
              // return type
              const refString = `function ` + functionInsert.name + `(` + functionInsert.argsString + `) returns (bool)`;
              const repString = `function ` + functionInsert.name + `(` + functionInsert.argsString + `) returns (` + match[1] + `)`;
              newContract.sourceCode = newContract.sourceCode.replace(refString, repString);
              newContract.lineBreaks = sourceMappingDecoder.getLinebreakPositions(newContract.sourceCode);
              result = compile(newContract.sourceCode, 0);
            }
            else {

            }
          }
          const compiledContract = result.contracts[":DebugContract"];

          // merge compilation
          newContract.assembly = compiledContract.assembly;
          newContract.bytecode = compiledContract.bytecode;
          newContract.functionHashes = compiledContract.functionHashes;
          newContract.gasEstimates = compiledContract.gasEstimates;
          newContract.interface = compiledContract.interface;
          newContract.metadata = compiledContract.metadata;
          newContract.opcodes = compiledContract.opcodes;
          newContract.runtimeBytecode = compiledContract.runtimeBytecode;
          newContract.srcmap = compiledContract.srcmap;
          newContract.srcmapRuntime = compiledContract.srcmapRuntime;

          // add our flair
          newContract.pcMap = code.util.nameOpCodes(new Buffer(newContract.runtimeBytecode, 'hex'))[1];
          newContract.functionNames = {};
          Object.keys(newContract.functionHashes).forEach((functionName) => {
            const pc = GetFunctionProgramCount(newContract.runtimeBytecode, newContract.functionHashes[functionName]);
            if (pc !== null) {
              newContract.functionNames[pc] = functionName;
            }
          });
          
          const astWalker = new util.AstWalker();
          let newVariables = new Map<number, Map<string, SdbVariable>>();
          astWalker.walkDetail(result.sources[""].AST, null, 0, (node, parent, depth) => {
            if (node.id) {
              newVariables.set(node.id, new Map<string, SdbVariable>());

              if (node.name === "VariableDeclaration") {
                let childIndex: number | null = null;
                if (parent) {
                  // look for the child in the parent to get the index
                  for (let i = 0; i < parent.children.length; i++) {
                    if (parent.children[i].id === node.id) {
                      childIndex = i;
                    }
                  }
                }

                // try to find the variable in our prior variable to get the stack position (which shouldn't have changed)
                let stackPosition: number | null = null;
                this._variables.forEach((variables, scopeId) => {
                  const variable = variables.get(node.attributes.name);
                  if (variable && variable.scope.depth === depth) {
                    stackPosition = variable.stackPosition;
                  }
                });

                const variable = <SdbVariable> {
                  name: node.attributes.name,
                  type: node.attributes.type,
                  scope: <SdbAstScope> {
                    id: node.attributes.scope,
                    childIndex: childIndex,
                    depth: depth
                  },
                  stackPosition: stackPosition
                };

                // add variable to the parent's scope
                newVariables.get(variable.scope.id)!.set(variable.name, variable);
              }
            }

            return true;
          });

          const codeOffset = functionInsert.code.length + functionInsert.reference.length + 1; // 1 is for the \n after the reference insertion

          let sourceLocationEvalFunction = null;
          astWalker.walk(result.sources[""].AST, (node) => {
            if (sourceLocationEvalFunction !== null) {
              return false;
            }

            if (node.name === "FunctionCall") {
              for (let i = 0; i < node.children.length; i++) {
                if (node.children[i].attributes.value === functionInsert.name) {
                  sourceLocationEvalFunction = sourceMappingDecoder.sourceLocationFromAstNode(node);
                  return true;
                }
              }
            }

            return true;
          });

          const newIndex = sourceMappingDecoder.toIndex(sourceLocationEvalFunction, newContract.srcmapRuntime);
          let newPc: number | null = null;
          Object.keys(newContract.pcMap).forEach((key, index) => {
            if (index === newIndex) {
              newPc = parseInt(key);
            }
          });

          let newSourceLocation = CircularJSON.parse(CircularJSON.stringify(this._stepData.source));
          newSourceLocation.start += codeOffset;
          let newLine: number | null = null;
          for (let i = 0; i < newContract.lineBreaks.length; i++) {
            if (i === 0 && newSourceLocation.start < newContract.lineBreaks[i]) {
              newLine = i;
              break;
            }
            else if (i > 0 && newContract.lineBreaks[i - 1] < newSourceLocation.start && newSourceLocation.start < newContract.lineBreaks[i]) {
              newLine = i;
              break;
            }
          }

          // TODO: set this. variables to new stuff
          this._compilationResult.errors = result.errors;
          this._compilationResult.sources["DebugContract.sol"] = result.sources[""];
          this._compilationResult.contracts[contractKey] = newContract;
          this._breakPoints = newBreakpoints;
          this._callStack = newCallstack;
          this._priorUiCallStack = newPriorUiCallstack;
          this._lineOffsets = newLineOffsets;
          this._variables = newVariables;

          if (newLine !== null) {
            this.setBreakPoint(newContract.sourcePath, newLine, false, false);
          }
          else {
            // TODO: handles this better
            console.log("ERROR: We could not find the line of after we're evaluating...but we're going to execute anyway? shrug");
          }

          this._ongoingEvaluation = <SdbEvaluation> {
            functionName: functionInsert.name,
            callback: (result) => {
              callback(result);
            }
          };

          // push the code
          const content = {
            "type": "putCodeRequest",
            "address": newContract.address,
            "code": newContract.runtimeBytecode,
            "pc": newPc
          };
          this.run(false, undefined, content);
        }
      }
    }
  }

  private addLineOffset(line: number, numLines: number, lineOffsets: Map<number, number> = this._lineOffsets) {
    const numPrevLines: number = lineOffsets.get(line) || 0;
    lineOffsets.set(line, numPrevLines + numLines);
  }

  // this is the line number in the original source using a modified/step data line number
  private getOriginalLine(newLine: number, lineOffsets: Map<number, number> = this._lineOffsets): number {
    let originalLine = newLine;

    lineOffsets.forEach((numLines, line) => {
      if (newLine >= line) {
        originalLine -= numLines;
      }
    });

    return originalLine;
  }

  // this is the line number in the modified source using an original line number
  private getNewLine(originalLine: number, lineOffsets: Map<number, number> = this._lineOffsets): number {
    let newLine = originalLine;

    lineOffsets.forEach((numLines, line) => {
      if (originalLine >= line) {
        newLine += numLines;
      }
    });

    return newLine;
  }

  private sendEvent(event: string, ... args: any[]) {
    setImmediate(_ => {
      this.emit(event, ...args);
    });
  }
}