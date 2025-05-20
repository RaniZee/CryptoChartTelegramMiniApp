from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    # Здесь можно будет добавить URL для подключения к БД,
    # секретные ключи и другие настройки, загружаемые из .env
    # Например:
    # DATABASE_URL: str = "postgresql+asyncpg://user:password@host:port/dbname"

    # Пока оставим пустым или добавим базовые настройки, если нужно
    APP_NAME: str = "Crypto Chart MiniApp API"

    class Config:
        env_file = ".env" # Указываем, что нужно загружать переменные из .env
        env_file_encoding = 'utf-8'

settings = Settings()

# Для использования: from backend.app.core.config import settings
# print(settings.APP_NAME)