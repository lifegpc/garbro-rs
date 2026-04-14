import { invoke } from "@tauri-apps/api/core";
import { GameTitle, Entry, FileOptions } from "./types";

export async function getStartDirectory(): Promise<string> {
  return await invoke("get_start_directory");
}

export async function getXp3SupportedGames(): Promise<GameTitle[]> {
  return await invoke("get_xp3_supported_games");
}

export async function listDirectory(path: string, options?: FileOptions[]): Promise<Entry[]> {
  return await invoke("list_directory", { path, options: options ?? null });
}

export async function previewImage(path: string, options?: FileOptions[]): Promise<Uint8Array> {
  return await invoke("preview_image", { path, options: options ?? null });
}
