FROM oven/bun:1

WORKDIR /app

# Copy package files and install dependencies
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Copy app source
COPY . .

# Bake the fictional example in as a fallback; supply your real context via CLAUDE_MD_B64 or the web UI upload
# Must use /home/bun since the app runs as the bun user (os.homedir() returns /home/bun)
RUN mkdir -p /home/bun/ClaudeContext && ln -s /home/bun/ClaudeContext "/home/bun/Claude Context"
COPY CLAUDE.example.md /home/bun/ClaudeContext/CLAUDE.md

RUN chown -R bun:bun /app /home/bun/ClaudeContext

USER bun

EXPOSE 3000

CMD ["bun", "run", "server.js"]
