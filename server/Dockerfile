FROM node:22-alpine

# Без зависимостей: сервер на голом node:http, npm install не нужен.
WORKDIR /app
COPY index.js ./

# Конфиг с ключом и каталог с файлами монтируются снаружи, в образ не попадают.
ENV PUUUSH_CONFIG=/srv/puuush-server/config.json
RUN mkdir -p /srv/media && chown node:node /srv/media

USER node
EXPOSE 8099

# Порт 8099 зашит. Если поменять port в config.json, проверка здоровья начнёт врать.
HEALTHCHECK --interval=30s --timeout=5s \
  CMD wget -q -O /dev/null http://127.0.0.1:8099/v1/health || exit 1

CMD ["node", "index.js"]
