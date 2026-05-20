FROM node:20-alpine
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci || npm install

COPY . .
RUN npm run build

ENV NODE_ENV=production
ENV PORT=8000
ENV HOST=0.0.0.0
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8000/api/health || exit 1

CMD ["npm", "start"]
