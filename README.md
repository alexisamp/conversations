# Conversations

Cliente nativo de WhatsApp para macOS con sidebar de RedThink. Reemplaza a WhatsApp.app.

> Ver `SPEC.md` para el diseño completo, decisiones y plan de fases.

## Fase actual: 0 — Electron shell

En esta fase, la app solo embebe WhatsApp Web en una ventana nativa. No hay sidebar, ni captura, ni sync con Supabase todavía.

### Requisitos

- Node 20+
- macOS (único target soportado)

### Correr en desarrollo

```bash
npm install
npm run dev
```

La primera vez tienes que escanear el QR code con tu teléfono. La sesión se persiste en `persist:whatsapp` (partición Electron) así que no hay que volver a escanear en cada arranque.

### Con DevTools

```bash
npm run dev:devtools
```

### Limpiar build

```bash
npm run clean
```

## Criterio de éxito de Fase 0

- La app abre en una ventana de ~1400×900
- WhatsApp Web carga sin el mensaje de "navegador no soportado"
- QR scan funciona
- Mensajes entran y salen
- Cmd+Q cierra la app
- Cmd+W cierra la ventana (la app sigue viva en el dock, comportamiento Mac estándar)

## Estructura

```
Conversations/
├── SPEC.md               ← diseño completo
├── electron/
│   ├── main.ts           lifecycle, ventana, UA spoof
│   └── preload.ts        (vacío en fase 0)
├── tsconfig.main.json
├── tsconfig.json
└── package.json
```
