declare module "fullstacked/tunnel" {
    export interface TunnelRegisterOptions {
        host: string;
        authorization: string;
    }
    const tunnel: {
        register(options: TunnelRegisterOptions): Promise<string>;
    };
    export default tunnel;
}
