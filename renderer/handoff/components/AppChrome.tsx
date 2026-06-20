// AppChrome.tsx — the dark application top bar: brand, window nav, channel tabs,
// search trigger, settings, avatar. WhatsApp keeps its own left menu, so channel
// switching lives ONLY here (do not add a second left rail).
//
// Styling: classes ".appbar", ".tab", ".ab-*", ".nav" in styles/styles.css.

import React from 'react';
import type { AppMode } from './types';

const Icon = ({ name }: { name: string }) => <i className={`ph ph-${name}`} aria-hidden />;

export interface Tab {
  mode: AppMode;
  label: string;
  icon: string;        // phosphor name
  badge?: number;      // optional count pip
}

const DEFAULT_TABS: Tab[] = [
  { mode: 'wa',     label: 'WhatsApp', icon: 'whatsapp-logo' },
  { mode: 'li',     label: 'LinkedIn', icon: 'linkedin-logo', badge: 3 },
  { mode: 'review', label: 'AI Review', icon: 'sparkle', badge: 7 },
  { mode: 'focus',  label: 'Focus', icon: 'target' },
  { mode: 'search', label: 'Discover', icon: 'compass' },
];

export interface AppChromeProps {
  mode: AppMode;
  onModeChange: (m: AppMode) => void;
  onOpenSearch: () => void;
  tabs?: Tab[];
  logoSrc?: string;
  /** Current user's initials for the avatar. */
  userInitials?: string;
}

export default function AppChrome({
  mode, onModeChange, onOpenSearch, tabs = DEFAULT_TABS, logoSrc, userInitials = 'AM',
}: AppChromeProps) {
  return (
    <div className="appbar">
      <div className="ab-brand">
        <span className="ab-logo">{logoSrc ? <img src={logoSrc} alt="reThink" /> : null}</span>
        <span className="ab-app">Conversations</span>
      </div>

      <div className="nav">
        <button title="Back"><Icon name="caret-left" /></button>
        <button className="dim" title="Forward"><Icon name="caret-right" /></button>
        <button title="Reload"><Icon name="arrow-clockwise" /></button>
      </div>

      <div className="tabs">
        {tabs.map(t => (
          <button key={t.mode} className={`tab ${mode === t.mode ? 'on' : ''}`} onClick={() => onModeChange(t.mode)}>
            <Icon name={t.icon} />{t.label}
            {t.badge != null && <span className="tb-pip">{t.badge}</span>}
          </button>
        ))}
      </div>

      <div className="appbar-right">
        <button className="ab-search" onClick={onOpenSearch}>
          <Icon name="magnifying-glass" /><span>Search</span><kbd>⌘K</kbd>
        </button>
        <button className="ab-icon" title="Settings"><Icon name="gear-six" /></button>
        <div className="ab-me"><span className="av-mono">{userInitials}</span></div>
      </div>
    </div>
  );
}
