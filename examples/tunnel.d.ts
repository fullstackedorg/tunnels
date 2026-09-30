declare module "fullstacked/tunnel" {
    export interface TunnelRegisterOptions {
        name?: string;
        host: string;
        port?: number;
        path?: string;
        unsecure?: boolean;
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
