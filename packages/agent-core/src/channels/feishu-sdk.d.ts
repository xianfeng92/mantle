/** Type stub for optional dependency @larksuiteoapi/node-sdk */
declare module "@larksuiteoapi/node-sdk" {
  export class Client {
    constructor(config: { appId: string; appSecret: string });
    im: {
      v1: {
        message: {
          create(params: any): Promise<any>;
          patch(params: any): Promise<any>;
        };
        messageResource: {
          get(params: {
            path: { message_id: string; file_key: string };
            params: { type: string };
          }): Promise<Buffer>;
        };
      };
    };
  }
  export class WSClient {
    constructor(config: any);
    start(options: any): Promise<void>;
  }
  export class EventDispatcher {
    constructor(config: any);
    register(
      handlers: Record<string, (data: any) => Promise<void>>,
    ): EventDispatcher;
  }
  export enum LoggerLevel {
    info = "info",
  }
}
