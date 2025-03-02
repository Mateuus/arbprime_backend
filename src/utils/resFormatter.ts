export interface ApiResponse<T> {
    result: number;
    message: string;
    data: T;
}

export const createResponse = <T>(result: number, message: string, data: T): ApiResponse<T> => {
    return {
      result,
      message,
      data,
    };
};
