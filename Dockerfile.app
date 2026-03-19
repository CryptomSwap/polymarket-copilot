FROM node:20-bullseye-slim

WORKDIR /app

ENV NEXT_TELEMETRY_DISABLED=1

# Install dependencies first for better layer caching
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci

# Copy the rest of the source code
COPY . .

EXPOSE 3000

# Dev-mode local runtime (no dependency on Cursor). Source is expected to be bind-mounted.
CMD ["npm","run","dev","--","-p","3000","-H","0.0.0.0"]

