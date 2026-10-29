declare module "fullstacked/tunnel" {
    export interface TunnelRegisterOptions {
        /** Virtual host name to register (generated when omitted). */
        name?: string;
        /** The Hub's hostname, without a port. */
        host: string;
        /** Defaults to 443, or 80 with `unsecure`. */
        port?: number;
        /**
         * Request path of the upgrade. The Hub serves tunnel sessions on `/` only: leave it unset
         * unless a reverse proxy in front of the Hub rewrites it to `/` (other paths get 404).
         */
        path?: string;
        /** Plain `ws://` instead of `wss://`. */
        unsecure?: boolean;
        /** The tunnel token (`tun_...`). */
        authorization?: string;
    }
    const tunnel: {
        register(options: TunnelRegisterOptions): Promise<string>;
    };
    export default tunnel;
}

declare module "fullstacked/websocket" {
    const ws: typeof WebSocket;
    export default ws;
}
