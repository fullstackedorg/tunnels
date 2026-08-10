import { GitProxy } from "../fullstacked/platform/node/types/@types/git";
import { Tunnel } from "../fullstacked/platform/node/types/@types/tunnel";

declare global {
    var testData: any;
    var testResult: (result: any) => void;
    var tunnel: Tunnel | undefined;
    var proxy: GitProxy | undefined;
}