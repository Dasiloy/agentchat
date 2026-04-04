import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, IsStrongPassword } from 'class-validator';

export class RegisterDto {
  @ApiProperty({ example: 'alice@example.com', type: 'string', required: true })
  @IsEmail()
  email: string;

  @ApiProperty({
    example: 'strongpassword',
    minLength: 8,
    type: 'string',
    required: true,
  })
  @IsStrongPassword({
    minLength: 8,
    minLowercase: 1,
    minSymbols: 1,
    minUppercase: 1,
  })
  password: string;

  @ApiProperty({ example: 'Alice Becca', type: 'string', required: true })
  @IsString()
  name: string;
}
