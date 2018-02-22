import { LibSdbTypes } from "./types";
import { LibSdbUtils } from "./utils/utils";
import { LibSdbRuntime } from "./runtime";

export class LibSdbBreakpoints {
    private _runtime: LibSdbRuntime;

    private _breakpointId: number;

    constructor(runtime: LibSdbRuntime) {
        this._runtime = runtime;
        this._breakpointId = 1;
    }

    public async setBreakPoint(path: string, line: number, visible: boolean = true, originalSource: boolean = true): Promise<LibSdbTypes.Breakpoint> {
        if (!this._runtime._files.has(path)) {
            this._runtime._files.set(path, new LibSdbTypes.File("/", path));
        }
        const file = this._runtime._files.get(path)!;

        if (originalSource) {
            // we need to modify the line number using line offsets with the original source bp's
            line = LibSdbUtils.getNewLine(line, file.lineOffsets);
        }

        let bp = new LibSdbTypes.Breakpoint();
        bp.verified = false;
        bp.line = line;
        bp.id = this._breakpointId++;
        bp.visible = visible;
        bp.originalSource = originalSource;

        if (file) {
            if (file.breakpoints.indexOf(bp) === -1) {
                file.breakpoints.push(bp);
            }

            await this.verifyBreakpoints(path);
        }

        return bp;
    }

    public async verifyAllBreakpoints(): Promise<void> {
        for (const file of this._runtime._files) {
            await this.verifyBreakpoints(file[0]);
        }
    }

    public async verifyBreakpoints(path: string): Promise<void> {
        const file = this._runtime._files.get(path);

        if (file) {
            for (let i = 0; i < file.breakpoints.length; i++) {
                const bp = file.breakpoints[i];
                // Temporarily validate each breakpoint
                bp.verified = true;
                this._runtime.sendEvent('breakpointValidated', bp);

                // TODO: real breakpoint verification

                const astWalker = new LibSdbUtils.AstWalker();
                const startPosition = bp.line === 0 ? 0 : file.lineBreaks[bp.line - 1] + 1;
                const endPosition = file.lineBreaks[bp.line];
                let sourceLocation: any = null;
                let address: string = "";
                let index: number | null = null;
                let pc: number | null = null;
                for (let j = 0; j < file.contracts.length; j++) {
                    const contract = file.contracts[j];
                    if (contract.address !== "") {
                        astWalker.walk(contract.ast, (node) => {
                            if (node.src) {
                                const srcSplit = node.src.split(":");
                                const pos = parseInt(srcSplit[0]);
                                if (startPosition <= pos && pos <= endPosition) {
                                    sourceLocation = {
                                        start: parseInt(srcSplit[0]),
                                        length: parseInt(srcSplit[1]),
                                        file: parseInt(srcSplit[2])
                                    };
                                    return false;
                                }
                            }

                            return true;
                        });
                        if (sourceLocation !== null) {
                            address = contract.address;
                            index = LibSdbUtils.SourceMappingDecoder.toIndex(sourceLocation, contract.srcmapRuntime);
                            if (index !== null) {
                                for (const entry of contract.pcMap.entries()) {
                                    if (entry[1] === index) {
                                        pc = entry[0];
                                        await this._runtime._interface.requestSendBreakpoint(bp.id, address, pc, true);
                                        break;
                                    }
                                }
                            }
                            break;
                        }
                    }
                };
            };
        }
    }

    public async clearBreakpoint(path: string, line: number): Promise<LibSdbTypes.Breakpoint | undefined> {
        const file = this._runtime._files.get(path); // TODO: handle when file isn't in this._files

        if (file) {
            const index = file.breakpoints.findIndex(bp => bp.line === line);
            if (index >= 0) {
                const bp = file.breakpoints[index];
                await this._runtime._interface.requestSendBreakpoint(bp.id, "", 0, false);
                file.breakpoints.splice(index, 1);
                return bp;
            }
        }

        return undefined;
    }

    public async clearBreakpoints(path: string): Promise<void> {
        const file = this._runtime._files.get(path);

        if (file) {
            for (let i = 0; i < file.breakpoints.length; i++) {
                await this._runtime._interface.requestSendBreakpoint(file.breakpoints[i].id, "", 0, false);
            }
            file.breakpoints = [];
        }
    }
}