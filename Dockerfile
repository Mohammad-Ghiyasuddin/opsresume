FROM node:22-alpine
WORKDIR /app
COPY package.json server.js index.html styles.css theme.css app.js ./
ENV HOST=0.0.0.0 PORT=8000 NODE_ENV=production
EXPOSE 8000
USER node
CMD ["node", "server.js"]
