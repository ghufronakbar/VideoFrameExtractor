import cloudinary from '../config/cloudinary.js';
import multer from 'multer';
import { CloudinaryStorage } from 'multer-storage-cloudinary';
import { CLOUDINARY_FOLDER } from '../constant/cloudinary.js';
import randomCharacter from './randomCharacter.js';

export const uploadCloudinary = (allowedFormats = ['mp4', 'webm', 'ogg', 'png', 'jpg', 'jpeg', 'gif', 'wav']) => {
    const storage = new CloudinaryStorage({
        cloudinary: cloudinary,
        params: {
            folder: CLOUDINARY_FOLDER,
            resource_type: 'auto', // penting: biar support video, image, audio
            format: async (req, file) => {
                // biarkan Cloudinary auto-detect format atau set manual jika mau
                const ext = file.mimetype.split('/')[1];
                return ext;
            },
            public_id: (req, file) => randomCharacter(8),
        }
    });

    return multer({ storage: storage });
};
