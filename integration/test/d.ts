import type { GitProxy } from "../fullstacked/platform/node/types/@types/git.d.ts";
import type { Tunnel } from "../fullstacked/platform/node/types/@types/tunnel.d.ts";

declare global {
    var testData: any;
    var testResult: (result: any) => void;
    var tunnel: Tunnel | undefined;
    var proxy: GitProxy | undefined;
}