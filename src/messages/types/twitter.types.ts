export type XAuth =
  | {
      mode: 'OAUTH2_BEARER';
      bearerToken: string;
    }
  | {
      mode: 'OAUTH1A_USER';
      appKey: string;
      appSecret: string;
      accessToken: string;
      accessSecret: string;
    };

export type XSendResult = {
  provider: 'X';
  messageId?: string;
  raw: any;
};
