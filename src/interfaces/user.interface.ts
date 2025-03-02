export interface UserRegister {
    email: string;
    password: string;
}

export interface UserResponseDTO {
    id: string;
    username: string;
    email: string;
    role: string;
}