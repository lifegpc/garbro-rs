use anyhow::Result;
use msg_tool::scripts::base::ReadSeek;
use msg_tool::scripts::{BUILDER, ScriptBuilder};
use msg_tool::types::{ExtraConfig, ImageOutputType, ScriptType};
use msg_tool::utils::img::*;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs::File;
use std::io::Read;
use std::path::Path;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

const PNG_SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";

lazy_static::lazy_static! {
    static ref ENTRY_TYPE_CACHE: Mutex<BTreeMap<ScriptType, EntryType>> = Mutex::new(BTreeMap::new());
}

fn query_entry_type(script_type: &ScriptType) -> EntryType {
    let mut cache = ENTRY_TYPE_CACHE.lock().unwrap();
    if let Some(entry_type) = cache.get(script_type) {
        return entry_type.clone();
    }
    let entry_type = if script_type.is_audio() {
        EntryType::Audio
    } else {
        let builder = BUILDER
            .iter()
            .find(|b| b.script_type() == script_type)
            .unwrap_or_else(|| panic!("不支持的文件格式: {:?}", script_type));
        builder.entry_type()
    };
    cache.insert(script_type.clone(), entry_type.clone());
    entry_type
}

/// 到时候可能考虑把识别写到msg_tool那里
trait ScriptTypeExt {
    fn is_audio(&self) -> bool;
}

impl ScriptTypeExt for ScriptType {
    fn is_audio(&self) -> bool {
        matches!(self, ScriptType::BGIAudio | ScriptType::CircusPcm)
    }
}

trait ScriptBuilderExt {
    fn entry_type(&self) -> EntryType;
}

impl<T: ScriptBuilder + ?Sized> ScriptBuilderExt for T {
    fn entry_type(&self) -> EntryType {
        if self.is_image() {
            EntryType::Image
        } else if self.is_archive() {
            EntryType::Archive
        } else if self.script_type().is_audio() {
            EntryType::Audio
        } else {
            EntryType::Unknown
        }
    }
}

#[derive(Debug, Serialize, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub enum EntryType {
    Archive,
    Text,
    Image,
    Audio,
    Folder,
    Unknown,
}

#[derive(Debug, Serialize, Clone)]
pub struct Entry {
    name: String,
    is_dir: bool,
    entry_type: EntryType,
    msg_tool_type: Option<ScriptType>,
    /// 归档中目前还不支持
    size: Option<u64>,
}

#[derive(Debug, Serialize, Clone)]
pub struct GameTitle {
    name: String,
    alias: Option<Vec<String>>,
}

#[derive(Debug, Default, Deserialize, Clone)]
pub struct Xp3Option {
    /// 设置游戏标题，用于解密xp3文件
    game_title: Option<String>,
    /// 强制解密，部分xp3需要该参数才能正确解密
    force_decrypt: bool,
}

#[derive(Debug, Default, Deserialize, Clone)]
pub struct FileOptions {
    xp3: Option<Xp3Option>,
}

impl FileOptions {
    fn to_extra_config(&self) -> ExtraConfig {
        let mut config = ExtraConfig::default();
        if let Some(xp3) = &self.xp3 {
            config.xp3_game_title = xp3.game_title.clone();
            if config.xp3_game_title.is_some() {
                config.xp3_force_decrypt = xp3.force_decrypt;
            }
        }
        config
    }
}

#[derive(Debug, Serialize, Clone)]
pub enum ErrorType {
    NotFound,
    Other,
}

#[derive(Debug, Serialize, Clone)]
pub struct ErrorMsg {
    typ: ErrorType,
    msg: String,
}

pub fn get_last_directory(app: &AppHandle) -> Result<String> {
    let path = app.path().app_data_dir()?.join("last_directory.txt");
    let dir = std::fs::read_to_string(path)?.trim().to_string();
    Ok(dir)
}

#[tauri::command]
/// 获取启动时默认打开的目录
pub fn get_start_directory(app: AppHandle) -> String {
    if let Ok(dir) = get_last_directory(&app) {
        if std::path::Path::new(&dir).exists() {
            return dir;
        }
    }
    // 尝试获取上次关闭时的目录
    std::env::current_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| {
            std::env::current_exe()
                .ok()
                .and_then(|p| p.parent().map(|p| p.to_string_lossy().to_string()))
                .unwrap_or_else(|| ".".to_string())
        })
}

fn detect_file_type(filename: &str, data: &[u8]) -> (EntryType, Option<ScriptType>) {
    if data.starts_with(PNG_SIGNATURE) {
        return (EntryType::Image, None);
    }
    let filenames = filename.to_lowercase();
    let mut exts_builder = Vec::new();
    for builder in BUILDER.iter() {
        let exts = builder.extensions();
        for ext in exts {
            if filenames.ends_with(ext) {
                exts_builder.push(builder);
                break;
            }
        }
    }
    let exts_builder = if exts_builder.is_empty() {
        BUILDER.iter().collect::<Vec<_>>()
    } else {
        exts_builder
    };
    if exts_builder.len() == 1 {
        let builder = exts_builder[0];
        return (builder.entry_type(), Some(builder.script_type().clone()));
    }
    let mut scores = Vec::new();
    for builder in exts_builder.iter() {
        if let Some(score) = builder.is_this_format(filename, &data, data.len()) {
            scores.push((score, builder));
        }
    }
    if !scores.is_empty() {
        let max_score = scores.iter().map(|s| s.0).max().unwrap();
        let mut best_builders = Vec::new();
        for (score, builder) in scores.iter() {
            if *score == max_score {
                best_builders.push(builder);
            }
        }
        if best_builders.len() == 1 {
            let builder = best_builders[0];
            return (builder.entry_type(), Some(builder.script_type().clone()));
        }
    }
    (EntryType::Unknown, None)
}

fn list_fs_directory(path: &Path) -> Result<Vec<Entry>> {
    let mut result = Vec::new();
    for entry in std::fs::read_dir(path)? {
        let entry = entry?;
        let metadata = entry.metadata()?;
        let is_dir = metadata.is_dir();
        let name = entry.file_name().to_string_lossy().to_string();
        let (entry_type, msg_tool_type) = if is_dir {
            (EntryType::Folder, None)
        } else {
            let mut file = std::fs::File::open(entry.path())?;
            let mut buffer = [0; 1024];
            let n = file.read(&mut buffer)?;
            detect_file_type(&name, &buffer[..n])
        };
        let size = if is_dir { None } else { Some(metadata.len()) };
        result.push(Entry {
            name,
            is_dir,
            entry_type,
            msg_tool_type,
            size,
        });
    }
    Ok(result)
}

fn list_archive_directory(path: &Path, option: Option<&Vec<FileOptions>>) -> Result<Vec<Entry>> {
    let option = option
        .and_then(|opts| opts.get(0).cloned())
        .unwrap_or_default();
    let mut header = [0; 1024];
    let n = {
        let mut file = File::open(path)?;
        file.read(&mut header)?
    };
    let (entry_type, msg_tool_type) = detect_file_type(&path.to_string_lossy(), &header[..n]);
    if entry_type != EntryType::Archive {
        return Err(anyhow::anyhow!("不是归档文件"));
    }
    let script_type = msg_tool_type.ok_or_else(|| anyhow::anyhow!("无法识别的归档格式"))?;
    let builder = BUILDER
        .iter()
        .find(|b| b.script_type() == &script_type)
        .ok_or_else(|| anyhow::anyhow!("不支持的归档格式"))?;
    let extra_config = option.to_extra_config();
    let encoding = builder.default_encoding();
    let archive_encoding = builder.default_archive_encoding().unwrap_or(encoding);
    let archive = builder.build_script_from_file(
        &path.to_string_lossy(),
        encoding,
        archive_encoding,
        &extra_config,
        None,
    )?;
    let mut result = Vec::new();
    let mut index = 0;
    for entry in archive.iter_archive_filename()? {
        let name = entry?;
        let mut entry = archive.open_file(index)?;
        index += 1;
        let (entry_type, msg_tool_type) = if let Some(typ) = entry.script_type() {
            let entry_type = if typ.is_audio() {
                EntryType::Audio
            } else {
                query_entry_type(&typ)
            };
            (entry_type, Some(typ.clone()))
        } else {
            let mut buffer = [0; 1024];
            let n = entry.read(&mut buffer)?;
            detect_file_type(&name, &buffer[..n])
        };
        // 扁平结构，不区分文件夹，前端根据路径解析出文件夹结构
        result.push(Entry {
            name,
            is_dir: false,
            entry_type,
            msg_tool_type,
            size: None,
        });
    }
    Ok(result)
}

fn list_archive_directory_in_archive<'a>(
    path: &str,
    mut reader: Box<dyn ReadSeek + 'a>,
    filename: &str,
    option: Option<&Vec<FileOptions>>,
    typ: Option<ScriptType>,
    index: usize,
) -> Result<Vec<Entry>> {
    let foption = option
        .and_then(|opts| opts.get(index).cloned())
        .unwrap_or_default();
    let (entry_type, msg_tool_type) = if let Some(typ) = typ {
        let entry_type = if typ.is_audio() {
            EntryType::Audio
        } else {
            query_entry_type(&typ)
        };
        (entry_type, Some(typ.clone()))
    } else {
        let mut buffer = [0; 1024];
        let n = reader.read(&mut buffer)?;
        reader.rewind()?;
        detect_file_type("", &buffer[..n])
    };
    if entry_type != EntryType::Archive {
        return Err(anyhow::anyhow!("不是归档文件"));
    }
    let msg_tool_type = msg_tool_type.ok_or_else(|| anyhow::anyhow!("无法识别的归档格式"))?;
    let builder = BUILDER
        .iter()
        .find(|b| b.script_type() == &msg_tool_type)
        .ok_or_else(|| anyhow::anyhow!("不支持的归档格式"))?;
    let extra_config = foption.to_extra_config();
    let encoding = builder.default_encoding();
    let archive_encoding = builder.default_archive_encoding().unwrap_or(encoding);
    let archive = builder.build_script_from_reader(
        reader,
        filename,
        encoding,
        archive_encoding,
        &extra_config,
        None,
    )?;
    if path.contains("|") {
        let filename = path.split("|").nth(1).unwrap();
        let mut entry = archive.open_file_by_name(filename, false)?;
        let typ = entry.script_type().map(|t| t.clone());
        let path = path.splitn(2, "|").nth(1).unwrap();
        let entry = entry.to_data()?;
        return list_archive_directory_in_archive(
            path,
            Box::new(entry),
            filename,
            option,
            typ,
            index + 1,
        );
    }
    let mut result = Vec::new();
    let mut index = 0;
    for entry in archive.iter_archive_filename()? {
        let name = entry?;
        let mut entry = archive.open_file(index)?;
        index += 1;
        let (entry_type, msg_tool_type) = if let Some(typ) = entry.script_type() {
            let entry_type = if typ.is_audio() {
                EntryType::Audio
            } else {
                query_entry_type(&typ)
            };
            (entry_type, Some(typ.clone()))
        } else {
            let mut buffer = [0; 1024];
            let n = entry.read(&mut buffer)?;
            detect_file_type(&name, &buffer[..n])
        };
        // 扁平结构，不区分文件夹，前端根据路径解析出文件夹结构
        result.push(Entry {
            name,
            is_dir: false,
            entry_type,
            msg_tool_type,
            size: None,
        });
    }
    Ok(result)
}

fn set_last_directory(app: &AppHandle, dir: &str) -> Result<()> {
    let path = app.path().app_data_dir()?.join("last_directory.txt");
    std::fs::write(path, dir)?;
    Ok(())
}

/// options 如果path是文件系统中的文件夹，options 没有作用
/// 如果path是文件系统中的归档，options[0] 会用于打开该归档
/// 如果归档的文件内有嵌套归档，options[1] 会用于打开内层归档，以此类推
/// options可以None或者长度不足
/// 如果是归档，该函数会返回所有归档内的文件。不包含文件夹，文件夹需要前端根据文件路径解析。
/// # Example
/// path: /path/to/directory 列出目录下的所有文件和文件夹，options没有作用
/// path: /path/to/archive.zip 列出归档内的所有文件，options[0] 会用于打开该归档
/// path: /path/to/archive.zip|inner/ 不支持的路径格式，不会实现该种形式（需要在前端自行模拟文件夹结构）
/// path: /path/to/archive.zip|inner/archive2.zip 列出archive2.zip内的所有文件，options[0] 会用于打开archive.zip，options[1] 会用于打开archive2.zip
#[tauri::command]
pub fn list_directory(
    app: AppHandle,
    path: &str,
    options: Option<Vec<FileOptions>>,
) -> Result<Vec<Entry>, ErrorMsg> {
    if path.contains("|") {
        let filename = path.split("|").nth(0).unwrap();
        let reader = Box::new(std::io::BufReader::new(File::open(filename).map_err(
            |e| ErrorMsg {
                typ: ErrorType::NotFound,
                msg: format!("无法打开文件: {}", e),
            },
        )?));
        return list_archive_directory_in_archive(
            path,
            reader,
            filename,
            options.as_ref(),
            None,
            0,
        )
        .map_err(|e| ErrorMsg {
            typ: ErrorType::Other,
            msg: e.to_string(),
        });
    }
    let path = std::path::Path::new(path);
    if !path.exists() {
        return Err(ErrorMsg {
            typ: ErrorType::NotFound,
            msg: "目录不存在".to_string(),
        });
    }
    if path.is_file() {
        if let Some(parent) = path.parent() {
            let _ = set_last_directory(&app, parent.to_string_lossy().as_ref());
        }
        return list_archive_directory(path, options.as_ref()).map_err(|e| ErrorMsg {
            typ: ErrorType::Other,
            msg: e.to_string(),
        });
    }
    let _ = set_last_directory(&app, path.to_string_lossy().as_ref());
    list_fs_directory(path).map_err(|e| ErrorMsg {
        typ: ErrorType::Other,
        msg: e.to_string(),
    })
}

#[tauri::command]
pub fn get_xp3_supported_games() -> Vec<GameTitle> {
    let mut games = Vec::new();
    for (title, alias) in
        msg_tool::scripts::kirikiri::archive::xp3::get_supported_games_with_title()
    {
        let title = title.to_string();
        let alias = alias.map(|a| a.split("|").map(|s| s.trim().to_string()).collect());
        games.push(GameTitle { name: title, alias });
    }
    games
}

fn preview_image_in_directory<'a>(
    mut reader: Box<dyn ReadSeek + 'a>,
    filename: &str,
    options: Option<&Vec<FileOptions>>,
    script_type: Option<ScriptType>,
    index: usize,
) -> Result<Vec<u8>> {
    let (entry_type, msg_tool_type) = if let Some(typ) = script_type {
        let entry_type = if typ.is_audio() {
            EntryType::Audio
        } else {
            query_entry_type(&typ)
        };
        (entry_type, Some(typ.clone()))
    } else {
        let mut buffer = [0; 1024];
        let n = reader.read(&mut buffer)?;
        reader.rewind()?;
        detect_file_type(filename, &buffer[..n])
    };
    if entry_type != EntryType::Image {
        return Err(anyhow::anyhow!("无法预览非图片文件"));
    }
    if let Some(msg_tool_type) = msg_tool_type {
        let builder = BUILDER
            .iter()
            .find(|b| b.script_type() == &msg_tool_type)
            .ok_or_else(|| anyhow::anyhow!("不支持的图片格式"))?;
        let option = options
            .as_ref()
            .and_then(|opts| opts.get(index).cloned())
            .unwrap_or_default();
        let extra_config = option.to_extra_config();
        let encoding = builder.default_encoding();
        let archive_encoding = builder.default_archive_encoding().unwrap_or(encoding);
        let image = builder.build_script_from_reader(
            reader,
            filename,
            encoding,
            archive_encoding,
            &extra_config,
            None,
        )?;
        let mut buffer = Vec::new();
        let raw_image = image.export_image()?;
        encode_img_writer(raw_image, ImageOutputType::Png, &mut buffer, &extra_config)?;
        Ok(buffer)
    } else {
        // 直接返回原始数据
        let mut buffer = Vec::new();
        reader.read_to_end(&mut buffer)?;
        Ok(buffer)
    }
}

fn preview_image_in_archive<'a>(
    path: &str,
    mut reader: Box<dyn ReadSeek + 'a>,
    filename: &str,
    option: Option<&Vec<FileOptions>>,
    typ: Option<ScriptType>,
    index: usize,
) -> Result<Vec<u8>> {
    let foption = option
        .and_then(|opts| opts.get(index).cloned())
        .unwrap_or_default();
    let (entry_type, msg_tool_type) = if let Some(typ) = typ {
        let entry_type = if typ.is_audio() {
            EntryType::Audio
        } else {
            query_entry_type(&typ)
        };
        (entry_type, Some(typ.clone()))
    } else {
        let mut buffer = [0; 1024];
        let n = reader.read(&mut buffer)?;
        reader.rewind()?;
        detect_file_type("", &buffer[..n])
    };
    if entry_type != EntryType::Archive {
        return Err(anyhow::anyhow!("不是归档文件"));
    }
    let msg_tool_type = msg_tool_type.ok_or_else(|| anyhow::anyhow!("无法识别的归档格式"))?;
    let builder = BUILDER
        .iter()
        .find(|b| b.script_type() == &msg_tool_type)
        .ok_or_else(|| anyhow::anyhow!("不支持的归档格式"))?;
    let extra_config = foption.to_extra_config();
    let encoding = builder.default_encoding();
    let archive_encoding = builder.default_archive_encoding().unwrap_or(encoding);
    let archive = builder.build_script_from_reader(
        reader,
        filename,
        encoding,
        archive_encoding,
        &extra_config,
        None,
    )?;
    if path.contains("|") {
        let filename = path.split("|").nth(0).unwrap();
        let mut entry = archive.open_file_by_name(filename, false)?;
        let typ = entry.script_type().map(|t| t.clone());
        let path = path.splitn(2, "|").nth(1).unwrap();
        let entry = entry.to_data()?;
        return preview_image_in_archive(path, Box::new(entry), filename, option, typ, index + 1);
    }
    let mut entry = archive.open_file_by_name(path, false)?;
    let typ = entry.script_type().map(|t| t.clone());
    let entry = entry.to_data()?;
    preview_image_in_directory(Box::new(entry), filename, option, typ, index)
}

/// options 如果path是普通的图片文件，options没有作用
/// 如果path是文件系统中的归档，options[0] 会用于打开该图片文件
/// 如果归档的文件内有嵌套归档，options[1] 会用于打开归档内的图片文件，以此类推
/// options可以None或者长度不足
/// # Example
/// path: /path/to/image 预览该图片，options根据图片类型确定有没有作用
/// path: /path/to/archive.zip|image.png 预览archive.zip内的image.png，options[0] 会用于打开archive.zip， options[1] 会用于打开image.png（如果需要的话）
/// path: /path/to/archive.zip|inner/archive2.zip|image.png 预览archive2.zip内的image.png，options[0] 会用于打开archive.zip， options[1] 会用于打开archive2.zip， options[2] 会用于打开image.png（如果需要的话）
#[tauri::command]
pub fn preview_image(path: &str, options: Option<Vec<FileOptions>>) -> Result<Vec<u8>, ErrorMsg> {
    if path.contains("|") {
        let filename = path.split("|").nth(0).unwrap();
        let reader = Box::new(std::io::BufReader::new(File::open(filename).map_err(
            |e| ErrorMsg {
                typ: ErrorType::NotFound,
                msg: format!("无法打开文件: {}", e),
            },
        )?));
        let path = path.splitn(2, "|").nth(1).unwrap();
        return preview_image_in_archive(path, reader, filename, options.as_ref(), None, 0)
            .map_err(|e| ErrorMsg {
                typ: ErrorType::Other,
                msg: format!("预览图片失败: {}", e),
            });
    }
    let path = std::path::Path::new(path);
    if !path.exists() {
        return Err(ErrorMsg {
            typ: ErrorType::NotFound,
            msg: "文件不存在".to_string(),
        });
    }
    if path.is_dir() {
        return Err(ErrorMsg {
            typ: ErrorType::Other,
            msg: "无法预览文件夹".to_string(),
        });
    }
    let file = File::open(path).map_err(|e| ErrorMsg {
        typ: ErrorType::NotFound,
        msg: format!("无法打开文件: {}", e),
    })?;
    let file = std::io::BufReader::new(file);
    preview_image_in_directory(
        Box::new(file),
        path.to_string_lossy().as_ref(),
        options.as_ref(),
        None,
        0,
    )
    .map_err(|e| ErrorMsg {
        typ: ErrorType::Other,
        msg: format!("预览图片失败: {}", e),
    })
}
