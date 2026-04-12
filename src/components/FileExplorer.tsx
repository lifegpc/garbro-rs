import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Input, Button, Tooltip, Table, App as AntApp } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  FolderOutlined,
  FileOutlined,
  FileImageOutlined,
  SoundOutlined,
  CompressOutlined,
  FileTextOutlined,
  ArrowLeftOutlined,
  ArrowRightOutlined,
  ArrowUpOutlined,
} from '@ant-design/icons';
import { Entry, EntryType, FileOptions } from '../types';
import { listDirectory } from '../api';
import { Xp3OptionsDialog } from './Xp3OptionsDialog';

interface FileExplorerProps {
  initialPath: string;
  onEntrySelect?: (entry: Entry, fullPath: string, options?: FileOptions[]) => void;
}

/**
 * A location in the navigation history.
 * archiveSubdir === undefined  -> FS directory (always call backend)
 * archiveSubdir === ""         -> root of an archive
 * archiveSubdir === "bg/"      -> virtual subdir inside an archive
 *
 * backendPath for nested archives: "game.xp3|inner.dat"
 * options[N] corresponds to the N-th archive in the pipe-separated backendPath
 */
interface Location {
  backendPath: string;
  archiveSubdir?: string;
  options?: FileOptions[];
}

function locationDisplayPath(loc: Location): string {
  if (loc.archiveSubdir === undefined || loc.archiveSubdir === '') return loc.backendPath;
  return `${loc.backendPath}|${loc.archiveSubdir}`;
}

function parsePath(path: string): Location {
  const pipeIdx = path.indexOf('|');
  if (pipeIdx === -1) return { backendPath: path, archiveSubdir: undefined };
  return { backendPath: path.slice(0, pipeIdx), archiveSubdir: path.slice(pipeIdx + 1) };
}

function fsDirParent(path: string): string | null {
  const norm = path.replace(/\\/g, '/').replace(/\/+$/, '');
  const lastSlash = norm.lastIndexOf('/');
  if (lastSlash === -1) return null;
  if (lastSlash === 0) return '/';
  const parent = norm.slice(0, lastSlash);
  if (/^[A-Za-z]:$/.test(parent)) return parent + '/';
  return parent;
}

function archiveSubdirParent(subdir: string): string | null {
  if (subdir === '') return null;
  const trimmed = subdir.replace(/\/$/, '');
  const lastSlash = trimmed.lastIndexOf('/');
  if (lastSlash === -1) return '';
  return trimmed.slice(0, lastSlash + 1);
}

function getParentLocation(loc: Location): Location | null {
  if (loc.archiveSubdir === undefined) {
    const parent = fsDirParent(loc.backendPath);
    return parent ? { backendPath: parent } : null;
  }
  const parentSubdir = archiveSubdirParent(loc.archiveSubdir);
  if (parentSubdir !== null) return { ...loc, archiveSubdir: parentSubdir };
  const archiveParent = fsDirParent(loc.backendPath);
  return archiveParent ? { backendPath: archiveParent } : null;
}

function joinFsPath(dir: string, name: string): string {
  return dir.replace(/[/\\]+$/, '') + '/' + name;
}

function sortEntries(entries: Entry[]): Entry[] {
  return [...entries].sort((a, b) => {
    const aIsFolder = a.entry_type === 'Folder' ? 0 : 1;
    const bIsFolder = b.entry_type === 'Folder' ? 0 : 1;
    if (aIsFolder !== bIsFolder) return aIsFolder - bIsFolder;
    // 文件夹之间按名字排序，其他类型保持原始顺序
    if (aIsFolder === 0) return a.name.localeCompare(b.name);
    return 0;
  });
}

/**
 * Convert a flat archive listing into entries visible at the given virtual subdir.
 * virtualSubdir: "" = root, "bg/" = inside bg folder
 */
function buildVirtualDirEntries(flatEntries: Entry[], virtualSubdir: string): Entry[] {
  const result = new Map<string, Entry>();
  for (const entry of flatEntries) {
    const fullName = entry.name.replace(/\\/g, '/');
    if (!fullName.startsWith(virtualSubdir)) continue;
    const rest = fullName.slice(virtualSubdir.length);
    if (rest === '') continue;
    const slashIdx = rest.indexOf('/');
    if (slashIdx === -1) {
      result.set(rest, { ...entry, name: rest });
    } else {
      const folderName = rest.slice(0, slashIdx);
      if (!result.has(folderName)) {
        result.set(folderName, {
          name: folderName,
          is_dir: true,
          entry_type: 'Folder',
          msg_tool_type: undefined,
          size: undefined,
        });
      }
    }
  }
  return sortEntries(Array.from(result.values()));
}

function getEntryIcon(entryType: EntryType): React.ReactNode {
  switch (entryType) {
    case 'Folder':  return <FolderOutlined style={{ color: '#faad14' }} />;
    case 'Image':   return <FileImageOutlined style={{ color: '#52c41a' }} />;
    case 'Audio':   return <SoundOutlined style={{ color: '#1677ff' }} />;
    case 'Archive': return <CompressOutlined style={{ color: '#eb2f96' }} />;
    case 'Text':    return <FileTextOutlined style={{ color: '#722ed1' }} />;
    default:        return <FileOutlined style={{ color: '#8c8c8c' }} />;
  }
}

function getTypeLabel(entryType: EntryType): string {
  switch (entryType) {
    case 'Folder':  return '文件夹';
    case 'Archive': return '归档';
    case 'Image':   return '图片';
    case 'Audio':   return '音频';
    case 'Text':    return '文本';
    default:        return '未知';
  }
}

function formatSize(size?: number): string {
  if (size == null) return '';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

interface NavState {
  history: Location[];
  index: number;
}

export function FileExplorer({ initialPath, onEntrySelect }: FileExplorerProps) {
  const { message: messageApi } = AntApp.useApp();

  const [nav, setNav] = useState<NavState>({
    history: [{ backendPath: initialPath, archiveSubdir: undefined }],
    index: 0,
  });
  const currentLoc = nav.history[nav.index];

  const [pathInput, setPathInput] = useState(initialPath);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const archiveCache = useRef<Map<string, Entry[]>>(new Map());

  // Pending navigation for XP3 dialog
  const [xp3DialogOpen, setXp3DialogOpen] = useState(false);
  const pendingNavRef = useRef<{ target: Location; currentOptions?: FileOptions[] } | null>(null);

  const loadLocation = useCallback(async (loc: Location) => {
    setLoading(true);
    setSelectedKey(null);
    try {
      if (loc.archiveSubdir !== undefined) {
        const cacheKey = loc.options
          ? `${loc.backendPath}::${JSON.stringify(loc.options)}`
          : loc.backendPath;
        let flat = archiveCache.current.get(cacheKey);
        if (!flat) {
          flat = await listDirectory(loc.backendPath, loc.options);
          archiveCache.current.set(cacheKey, flat);
        }
        setEntries(buildVirtualDirEntries(flat, loc.archiveSubdir));
      } else {
        const result = await listDirectory(loc.backendPath);
        setEntries(sortEntries(result));
      }
    } catch (err: unknown) {
      const e = err as { msg?: string };
      messageApi.error(`无法打开: ${e?.msg ?? String(err)}`);
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [messageApi]);

  useEffect(() => {
    setPathInput(locationDisplayPath(currentLoc));
    loadLocation(currentLoc);
  }, [currentLoc, loadLocation]);

  const navigateTo = useCallback((loc: Location) => {
    setNav(prev => ({
      history: [...prev.history.slice(0, prev.index + 1), loc],
      index: prev.index + 1,
    }));
  }, []);

  const goBack = useCallback(() => {
    setNav(prev => prev.index > 0 ? { ...prev, index: prev.index - 1 } : prev);
  }, []);

  const goForward = useCallback(() => {
    setNav(prev => prev.index < prev.history.length - 1 ? { ...prev, index: prev.index + 1 } : prev);
  }, []);

  const goUp = useCallback(() => {
    const parent = getParentLocation(currentLoc);
    if (parent) navigateTo(parent);
  }, [currentLoc, navigateTo]);

  const handlePathSubmit = useCallback(() => {
    const trimmed = pathInput.trim();
    const current = locationDisplayPath(currentLoc);
    if (trimmed && trimmed !== current) {
      navigateTo(parsePath(trimmed));
    } else {
      loadLocation(currentLoc);
    }
  }, [pathInput, currentLoc, navigateTo, loadLocation]);

  const handleRowClick = useCallback((entry: Entry) => {
    setSelectedKey(entry.name);
    let fullPath: string;
    if (currentLoc.archiveSubdir !== undefined) {
      fullPath = `${currentLoc.backendPath}|${currentLoc.archiveSubdir}${entry.name}`;
    } else {
      fullPath = joinFsPath(currentLoc.backendPath, entry.name);
    }
    onEntrySelect?.(entry, fullPath, currentLoc.options);
  }, [currentLoc, onEntrySelect]);

  const handleRowDoubleClick = useCallback((entry: Entry) => {
    if (currentLoc.archiveSubdir !== undefined) {
      if (entry.entry_type === 'Folder') {
        navigateTo({ ...currentLoc, archiveSubdir: currentLoc.archiveSubdir + entry.name + '/' });
      } else if (entry.entry_type === 'Archive') {
        const innerPath = currentLoc.archiveSubdir + entry.name;
        const targetLoc: Location = { backendPath: `${currentLoc.backendPath}|${innerPath}`, archiveSubdir: '' };
        if (entry.msg_tool_type === 'KirikiriXp3') {
          pendingNavRef.current = { target: targetLoc, currentOptions: currentLoc.options };
          setXp3DialogOpen(true);
        } else {
          navigateTo(targetLoc);
        }
      }
    } else {
      if (entry.entry_type === 'Folder') {
        navigateTo({ backendPath: joinFsPath(currentLoc.backendPath, entry.name) });
      } else if (entry.entry_type === 'Archive') {
        const targetLoc: Location = { backendPath: joinFsPath(currentLoc.backendPath, entry.name), archiveSubdir: '' };
        if (entry.msg_tool_type === 'KirikiriXp3') {
          pendingNavRef.current = { target: targetLoc, currentOptions: currentLoc.options };
          setXp3DialogOpen(true);
        } else {
          navigateTo(targetLoc);
        }
      }
    }
  }, [currentLoc, navigateTo]);

  const handleXp3Confirm = useCallback((options: FileOptions | null) => {
    setXp3DialogOpen(false);
    const pending = pendingNavRef.current;
    pendingNavRef.current = null;
    if (!pending) return;

    if (options) {
      const { target, currentOptions } = pending;
      // Index of the new archive in the pipe-separated backendPath (0-based)
      const idx = target.backendPath.split('|').length - 1;
      const opts: FileOptions[] = [...(currentOptions ?? [])];
      while (opts.length < idx) opts.push({});
      opts[idx] = options;
      navigateTo({ ...target, options: opts });
    } else {
      navigateTo(pending.target);
    }
  }, [navigateTo]);

  const handleXp3Cancel = useCallback(() => {
    setXp3DialogOpen(false);
    pendingNavRef.current = null;
  }, []);

  const canGoBack = nav.index > 0;
  const canGoForward = nav.index < nav.history.length - 1;
  const canGoUp = getParentLocation(currentLoc) !== null;

  const columns: ColumnsType<Entry> = [
    {
      title: '名称',
      dataIndex: 'name',
      key: 'name',
      ellipsis: true,
      render: (name: string, record) => (
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {getEntryIcon(record.entry_type)}
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {name}
          </span>
        </span>
      ),
    },
    {
      title: '类型',
      dataIndex: 'entry_type',
      key: 'entry_type',
      width: 60,
      render: (type: EntryType) => (
        <span style={{ color: '#8c8c8c', fontSize: 12 }}>{getTypeLabel(type)}</span>
      ),
    },
    {
      title: '大小',
      dataIndex: 'size',
      key: 'size',
      width: 75,
      align: 'right' as const,
      render: (size?: number) => (
        <span style={{ color: '#8c8c8c', fontSize: 12 }}>{formatSize(size)}</span>
      ),
    },
  ];

  return (
    <div className="file-explorer">
      <Xp3OptionsDialog
        open={xp3DialogOpen}
        onConfirm={handleXp3Confirm}
        onCancel={handleXp3Cancel}
      />
      <div className="file-explorer__toolbar">
        <Tooltip title="后退">
          <Button size="small" type="text" icon={<ArrowLeftOutlined />}
            disabled={!canGoBack} onClick={goBack} />
        </Tooltip>
        <Tooltip title="前进">
          <Button size="small" type="text" icon={<ArrowRightOutlined />}
            disabled={!canGoForward} onClick={goForward} />
        </Tooltip>
        <Tooltip title="上一级">
          <Button size="small" type="text" icon={<ArrowUpOutlined />}
            disabled={!canGoUp} onClick={goUp} />
        </Tooltip>
        <Input
          size="small"
          value={pathInput}
          onChange={e => setPathInput(e.target.value)}
          onPressEnter={handlePathSubmit}
          onBlur={handlePathSubmit}
          style={{ flex: 1, fontFamily: 'monospace', fontSize: 12 }}
        />
      </div>
      <Table<Entry>
        size="small"
        columns={columns}
        dataSource={entries}
        rowKey="name"
        loading={loading}
        pagination={false}
        scroll={{ y: 'calc(100vh - 80px)' }}
        rowClassName={record => record.name === selectedKey ? 'file-explorer__row--selected' : ''}
        onRow={record => ({
          onClick: () => handleRowClick(record),
          onDoubleClick: () => handleRowDoubleClick(record),
          style: { cursor: 'default' },
        })}
      />
    </div>
  );
}
