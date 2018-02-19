import { LibSdbTypes } from "../types";
import { AstWalker } from "./astWalker";

export const fileSeparator: string = /^win/.test(process.platform) ? "\\" : "/";

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

export function adjustBreakpointLineNumbers(breakpoints: LibSdbTypes.Breakpoint[], path: string, startLine: number, numLines: number): void {
    for (let i = 0; i < breakpoints.length; i++) {
        if (breakpoints[i].line >= startLine) {
            breakpoints[i].line += numLines;
        }
    }
};

export function adjustCallstackLineNumbers(callstack: LibSdbTypes.StackFrame[], path: string, startLine: number, numLines: number): void {
    for (let i = 0; i < callstack.length; i++) {
        if (callstack[i].file === path && callstack[i].line >= startLine) {
            callstack[i].line += numLines;
        }
    }
};

export function addLineOffset(line: number, numLines: number, lineOffsets: Map<number, number>) {
    const numPrevLines: number = lineOffsets.get(line) || 0;
    lineOffsets.set(line, numPrevLines + numLines);
}

// this is the line number in the original source using a modified/step data line number
export function getOriginalLine(newLine: number, lineOffsets: Map<number, number>): number {
    let originalLine = newLine;

    lineOffsets.forEach((numLines, line) => {
        if (newLine >= line) {
            originalLine -= numLines;
        }
    });

    return originalLine;
}

// this is the line number in the modified source using an original line number
export function getNewLine(originalLine: number, lineOffsets: Map<number, number>): number {
    let newLine = originalLine;

    lineOffsets.forEach((numLines, line) => {
        if (originalLine >= line) {
            newLine += numLines;
        }
    });

    return newLine;
}

export function findScope(index: number, ast: LibSdbTypes.Ast): LibSdbTypes.AstScope[] {
    let scope: LibSdbTypes.AstScope[] = [];

    const astWalker = new AstWalker();
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
            let astScope = new LibSdbTypes.AstScope();
            astScope.id = node.id;
            astScope.childIndex = childIndex;
            astScope.depth = depth;
            scope.unshift(astScope);
            return true;
        }
        else {
            return false;
        }
    });

    return scope;
}

/*
   Binary Search:
   Assumes that @arg array is sorted increasingly
   return largest i such that array[i] <= target; return -1 if array[0] > target || array is empty
 */
export function findLowerBound(target, array) {
    let start = 0;
    let length = array.length;
    while (length > 0) {
        let half = length >> 1; // tslint:disable-line no-bitwise
        let middle = start + half;
        if (array[middle] <= target) {
            length = length - 1 - half;
            start = middle + 1;
        } else {
            length = half;
        }
    }
    return start - 1;
}