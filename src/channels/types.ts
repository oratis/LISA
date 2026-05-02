export interface IncomingMessage {
  channel: string;
  from: string;
  text: string;
  threadId?: string;
  receivedAt: Date;
}

export interface OutgoingMessage {
  channel: string;
  to: string;
  text: string;
  threadId?: string;
}

export interface ChannelAdapter {
  readonly name: string;
  start(handler: (msg: IncomingMessage) => Promise<void>): Promise<void>;
  send(msg: OutgoingMessage): Promise<void>;
  stop(): Promise<void>;
}
