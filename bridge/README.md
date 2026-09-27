# Amygdala OAuth bridge

Dependency-free handler для Google OAuth. Bridge держит Google web client secret вне Obsidian, обменивает короткоживущий authorization code после проверки PKCE и обновляет access token. Содержимое заметок и refresh-токены в базе не сохраняются.

## Настройка Google

Создайте Google web OAuth client, настройте consent screen и точный HTTPS redirect URI, например `https://your-bridge.example/oauth/callback`. Разверните `worker.mjs` как module entry point. В настройках хостинга задайте `GOOGLE_CLIENT_ID`, secret `GOOGLE_CLIENT_SECRET`, `OAUTH_REDIRECT_URI`; при необходимости `ALLOWED_ORIGIN`. Добавьте rate limiting и исключите URL callback и token responses из логов.

В Google Cloud требуются Drive API и Sheets API. Native desktop/mobile Google Picker OAuth flow использует `trigger_onepick=true`; Web Picker API key не требуется. Добавьте участников закрытой beta как OAuth test users. В testing mode Google может запросить вход повторно примерно через неделю.

## Форматы и scopes

- Personal 0.1: `drive.appdata openid email`. Скрытое личное хранилище остаётся без изменений.
- Legacy team 0.2: `drive openid email`, для существующей опубликованной beta. Этот формат отдельный и использует файлы Drive внутри выбранной папки.
- Team 0.3: `drive.file`. Picker возвращает ID выбранной Google Таблицы. Командное хранилище создаёт обычную папку и один spreadsheet с вкладками Meta, Events, Blobs, BlobIndex и TeamPlugins. Журнал DAG и бинарные данные хранятся строками/фрагментами в выбранной таблице; запросы не перечисляют остальной Drive.

При обмене кода bridge сохраняет в allowlist ответов поле `scope`; callback передаёт scope и `picked_file_ids` в Obsidian deep link. Плагин проверяет подтверждение `drive.file`, затем самостоятельно проверяет формат таблицы, расположение в папке, права редактора и permission ID участника.

Плагины хранят отдельные OAuth secrets и локальные журналы для личного и командного режимов. Email нужен локально для нахождения разрешения участника и не пишется в историю. Drive управляет доступом; сквозного шифрования нет.

## Routes

- `GET /health` → `{ configured }`.
- `POST /auth/start` JSON `{ challenge, state, mode?, teamFormat?, pickTeamStore? }` → `{ url }`; пропущенный mode означает `personal`, а пропущенный teamFormat для старых клиентов сохраняет legacy team 0.2.
- `GET /oauth/callback` → безопасная HTML-страница со ссылкой `obsidian://amygdala-connection-oauth`, кодом, state, результатом Picker и разрешённым scope.
- `POST /auth/exchange` JSON `{ code, verifier, state? }` → только allowlisted token fields.
- `POST /auth/refresh` JSON `{ refreshToken }` → только allowlisted token fields.

Проверка локального bridge: `node --test test/bridge.test.mjs`. Fake-provider тесты не доказывают production-конфигурацию или реальный вход двух Google-аккаунтов.
