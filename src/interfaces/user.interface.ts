export type UserData = {
    id: string;
    email: string;
    role: string;
}

export interface UserRegister {
    email: string;
    password: string;
}

export interface UserResponseDTO {
    id: string;
    fullname: string;
    personal_id: string;
    phone: string;
    email: string;
    balace: string;
    role: string;
    level: number;
    referralCode: string;
    token: string;
    profile: string;
}