import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, IsString } from 'class-validator';

export class LoginDto {
  @ApiProperty({ example: 'alice@example.com' })
  @IsEmail()
  email: string;

  @ApiProperty({ example: 'strongpassword' })
  @IsString()
  @IsNotEmpty()
  password: string;
}
