import { EvmInterface } from "../../../interface/evm";
import { LibSdbTypes } from "../../types";
import { decode as decodeValue } from "./value";
import { BN } from "bn.js";

export async function decode(position: BN, offset: number, length: number, detail: LibSdbTypes.ValueDetail | LibSdbTypes.EnumDetail, _interface: EvmInterface, address: string): Promise<string> {
    let value = "";

    if (position === null) {
        value = "(storage location undefined)";
    }
    else {
        const content = await _interface.requestStorage(address, position.toBuffer("be", 32));
        let end = content.value.length - offset;
        let start = end - length;
        if (start < 0) {
            start = 0;
        }
        if (end < 0) {
            end = 0;
        }
        value = decodeValue(detail, new BN(content.value.slice(start, end)));
    }

    return value;
}