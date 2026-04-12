import { useState, useEffect } from 'react';
import { Modal, Select, Switch, Form } from 'antd';
import { GameTitle, FileOptions } from '../types';
import { getXp3SupportedGames } from '../api';

interface Xp3OptionsDialogProps {
  open: boolean;
  onConfirm: (options: FileOptions | null) => void;
  onCancel: () => void;
}

export function Xp3OptionsDialog({ open, onConfirm, onCancel }: Xp3OptionsDialogProps) {
  const [games, setGames] = useState<GameTitle[]>([]);
  const [gamesLoading, setGamesLoading] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [gameTitle, setGameTitle] = useState<string | undefined>(undefined);
  const [forceDecrypt, setForceDecrypt] = useState(false);

  useEffect(() => {
    if (open) {
      setEnabled(false);
      setGameTitle(undefined);
      setForceDecrypt(false);
      if (games.length === 0) {
        setGamesLoading(true);
        getXp3SupportedGames().then(g => {
          setGames(g);
          setGamesLoading(false);
        });
      }
    }
  }, [open]);

  const handleOk = () => {
    if (!enabled) {
      onConfirm(null);
    } else {
      onConfirm({
        xp3: {
          game_title: gameTitle,
          force_decrypt: forceDecrypt,
        },
      });
    }
  };

  const gameOptions = games.map(g => {
    const label = g.alias ? `${g.name} (${g.alias.join(' / ')})` : g.name;
    return { value: g.name, label };
  });

  return (
    <Modal
      title="XP3 解密选项"
      open={open}
      onOk={handleOk}
      onCancel={onCancel}
      okText="确定"
      cancelText="取消"
      width={420}
    >
      <Form layout="vertical" style={{ marginTop: 16 }}>
        <Form.Item label="启用解密">
          <Switch checked={enabled} onChange={v => setEnabled(v)} />
        </Form.Item>
        <Form.Item label="游戏">
          <Select
            disabled={!enabled}
            value={gameTitle}
            onChange={setGameTitle}
            options={gameOptions}
            placeholder="选择游戏"
            allowClear
            showSearch
            loading={gamesLoading}
            filterOption={(input, option) =>
              String(option?.label ?? '').toLowerCase().includes(input.toLowerCase())
            }
            style={{ width: '100%' }}
          />
        </Form.Item>
        <Form.Item label="强制解密">
          <Switch
            disabled={!enabled}
            checked={enabled && forceDecrypt}
            onChange={v => setForceDecrypt(v)}
          />
        </Form.Item>
      </Form>
    </Modal>
  );
}
