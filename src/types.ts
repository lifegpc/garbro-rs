export interface GameTitle {
  name: string;
  alias?: string[];
}

export type EntryType = 'Archive' | 'Text' | 'Image' | 'Audio' | 'Folder' | 'Unknown';

export interface Entry {
  name: string;
  is_dir: boolean;
  entry_type: EntryType;
  msg_tool_type?: string;
  size?: number;
}

export interface FileOptions {
  xp3?: {
    game_title?: string;
    force_decrypt: boolean;
  };
}

export type ErrorType = 'NotFound' | 'Other';

export interface ErrorMsg {
  typ: ErrorType;
  msg: string;
}
