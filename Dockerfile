# Use the latest Node.js version
FROM node:20

# Create app directory
WORKDIR /usr/src/app

# Copy package files
COPY package*.json ./

# 🚀 This is the magic line: it uses 'install' instead of 'ci'
RUN npm install

# Copy the rest of your code (index.js, etc.)
COPY . .

# Expose the port (3000)
EXPOSE 3000

# Start the bot
CMD [ "node", "index.js" ]
