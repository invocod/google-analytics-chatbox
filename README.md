# google-analytics-ai-insights

Ask questions about your Google Analytics data in plain English. Get instant insights powered by Claude AI.

## Installation

```bash
npm install google-analytics-ai-insights
```

## Environment Variables

```env
GOOGLE_APPLICATION_CREDENTIALS=./path/to/ga-credentials.json
# OR for production:
GA_CREDENTIALS_JSON='{"type":"service_account",...}'

GA4_PROPERTY_ID=123456789
ANTHROPIC_API_KEY=sk-ant-...

# Optional
TEAM_ACCESS_TOKEN=your-secret-token
PORT=3000
CLAUDE_MODEL=claude-sonnet-4-20250514
```

## Usage

### As a standalone server

```bash
npm start
```

### As an npm package (e.g. from Laravel)

```js
const {
  createServer,
  queryGA4,
  processQuery,
} = require("google-analytics-ai-insights");

// Option 1: Start the full Express server (includes chat UI)
const { app, server } = await createServer({ port: 3001 });

// Option 2: Start server without the built-in frontend
const { app, server } = await createServer({
  port: 3001,
  serveFrontend: false,
});

// Option 3: Use functions directly (no server needed)
const data = await queryGA4({
  dimensions: ["date"],
  metrics: ["totalUsers", "sessions"],
  startDate: "7daysAgo",
  endDate: "yesterday",
});

const answer = await processQuery("How many users visited last week?");
```

### Laravel Integration

Run the chatbox as a sidecar Node service alongside your Laravel app.

**1. Install in your Laravel project:**

```bash
cd your-laravel-project
npm install google-analytics-ai-insights
```

**2. Create a start script** (`node-services/ga-chatbox.js`):

```js
require("dotenv").config(); // loads your Laravel .env
const { createServer } = require("google-analytics-ai-insights");

createServer({
  port: process.env.GA_CHATBOX_PORT || 3001,
  serveFrontend: false, // Laravel handles the frontend
});
```

**3. Add to your Laravel `package.json` scripts:**

```json
{
  "scripts": {
    "ga-chatbox": "node node-services/ga-chatbox.js"
  }
}
```

**4. Proxy from Laravel to the Node service:**

```php
// routes/api.php
Route::any('/ga-chatbox/{path}', function (Request $request, string $path) {
    $response = Http::withHeaders($request->headers->all())
        ->send(
            $request->method(),
            'http://localhost:3001/api/' . $path,
            ['body' => $request->getContent()]
        );

    return response($response->body(), $response->status())
        ->withHeaders($response->headers());
})->where('path', '.*');
```

**5. Run both services** (use `concurrently`, `pm2`, or Supervisor):

```bash
npx concurrently "php artisan serve" "npm run ga-chatbox"
```

## API Endpoints

| Method | Path          | Description                        |
| ------ | ------------- | ---------------------------------- |
| GET    | /api/health   | Health check                       |
| POST   | /api/chat     | Natural language analytics queries |
| POST   | /api/query    | Direct GA4 API query               |
| GET    | /api/schema   | Available metrics and dimensions   |

## License

ISC
