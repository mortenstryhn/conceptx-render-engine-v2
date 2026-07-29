# Playwright base image ships with Chromium + all system deps pre-installed.
# Keep this version in sync with the "playwright" version in package.json.
FROM mcr.microsoft.com/playwright:v1.49.0-jammy

WORKDIR /app

# Install node deps first (better layer caching)
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# App source
COPY . .

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
