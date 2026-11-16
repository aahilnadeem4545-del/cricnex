FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
RUN npm run build
ENV NODE_ENV=production
ENV CRICNEX_DATA_DIR=/data
ENV CRICNEX_BACKUP_DIR=/data/backups
ENV CRICNEX_UI_DIR=/app/src/ui/dist
VOLUME ["/data"]
EXPOSE 4000
CMD ["npm", "start"]
