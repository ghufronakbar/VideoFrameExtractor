import { configDotenv } from "dotenv"
import { APP_NAME } from "./index.js"
configDotenv()

export const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME
export const CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY
export const CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET
export const CLOUDINARY_FOLDER = APP_NAME