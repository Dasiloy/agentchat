import { ApiProperty } from '@nestjs/swagger';
import { Length } from 'class-validator';

export class SearchUserDto {
  @ApiProperty({
    required: true,
    name: 'q',
    description: 'Search term, email or name prefix',
    example: 'bob',
  })
  @Length(3, 100, {
    message: 'Search can only be between 3 to 100 letters',
  })
  q: string;
}
