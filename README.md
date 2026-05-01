# Aula Clara

MVP local para grabar audio de clases, transcribirlo, generar resumenes y hacer preguntas sobre la transcripcion.

Tambien funciona como PWA: en celular o PC se puede instalar desde el navegador cuando este publicada con HTTPS.

## Ejecutar

```powershell
$env:OPENAI_API_KEY="tu_api_key"
npm start
```

Luego abre:

```text
http://localhost:3000
```

La app tambien abre sin `OPENAI_API_KEY`, pero la transcripcion, resumen y preguntas necesitan la clave en el servidor.

## Abrir en tu celular

Arranca la app en tu computadora y mira la consola. Ademas de `localhost`, aparecera una linea como:

```text
Celular en el mismo Wi-Fi: http://192.168.1.50:3000
```

Abre esa URL desde el navegador de tu celular. La computadora y el celular deben estar conectados al mismo Wi-Fi, y Windows puede pedir permiso de firewall para Node.js.

Si `npm` o `node` no aparecen en tu PowerShell, usa el script incluido:

```powershell
powershell -ExecutionPolicy Bypass -File .\run-aula-clara.ps1
```

## Modelos

Puedes cambiar los modelos con variables de entorno:

```powershell
$env:OPENAI_TRANSCRIBE_MODEL="gpt-4o-mini-transcribe"
$env:OPENAI_TEXT_MODEL="gpt-5"
```

## Que incluye

- Grabacion de microfono desde el navegador.
- Importacion de archivos de audio.
- Guardado local de clases y audios con `localStorage` e `IndexedDB`.
- Transcripcion por `/v1/audio/transcriptions`.
- Resumen y preguntas por `/v1/responses`.
- Modo local gratis para resumenes y preguntas cuando no hay cuota de API.
- Interfaz movil con pestañas de Clases, Grabar y Estudiar.
- `manifest.webmanifest` y `sw.js` para instalarla como app.

## Publicar gratis en Render

1. Sube esta carpeta a un repositorio de GitHub.
2. En Render, crea un nuevo **Web Service** desde ese repositorio.
3. Render detectara `render.yaml`; usa plan `free`, build `npm install` y start `npm start`.
4. Si no vas a usar API de OpenAI, no agregues `OPENAI_API_KEY`.
5. Si luego agregas API, pon `OPENAI_API_KEY` como Environment Variable en Render, nunca dentro del codigo.

Cuando Render termine, te dara una URL `https://...onrender.com`. Desde el celular abre esa URL y usa la opcion del navegador para instalar:

- Android Chrome: menu de tres puntos -> **Instalar app** o **Agregar a pantalla principal**.
- Windows Chrome/Edge: icono de instalar en la barra de direccion.
- iPhone Safari: compartir -> **Agregar a pantalla de inicio**.

Nota: el dictado en vivo depende del navegador. Chrome en Android suele funcionar mejor; iPhone puede limitar esa funcion.
