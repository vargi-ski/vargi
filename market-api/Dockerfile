FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js camp-notifications.js shop-notifications.js submission-notifications.js birthday-reminders.js birthdays.json ./
ENV NODE_ENV=production
EXPOSE 3000
CMD ["npm","start"]
