# Dashboard MP Ascensores — Arranque

## Primera vez (solo una vez)
```
cd C:\zendesk-proxy
npm install
```

## Cada vez que quieras usar el dashboard

**1. Abrir PowerShell y arrancar el servidor:**
```
cd C:\zendesk-proxy
node server.js
```
Verás: `Servidor MP Ascensores activo en http://localhost:3001`

**2. Abrir el dashboard:**
Abre `dashboard.html` directamente en Chrome o Edge.

Los datos cargan solos. La barra superior muestra el progreso (10-20 min la primera carga).

## Para forzar una actualización de datos
- Pulsa el botón **↺ Recargar Zendesk** en el dashboard, o
- Abre en el navegador: `http://localhost:3001/api/reload`

## Para cerrar
`Ctrl+C` en la PowerShell.

---
**Sin ngrok. Sin URL pública. Solo local.**
