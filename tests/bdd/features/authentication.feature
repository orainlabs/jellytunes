Feature: Autenticación Jellyfin
  Como usuario de Jellysync
  Quiero poder conectarme a mi servidor Jellyfin
  Para acceder a mi biblioteca de música

  Background:
    Given la aplicación Jellysync está iniciada

  Scenario: Conexión exitosa con credenciales válidas
    Given el usuario tiene una URL de servidor Jellyfin válida
    And el usuario tiene una API key válida
    When el usuario ingresa la URL del servidor "https://jellyfin.example.com"
    And el usuario ingresa la API key "valid-api-key-123"
    And el usuario hace click en el botón "Conectar"
    Then la aplicación debería conectarse exitosamente al servidor
    And debería mostrar la pantalla de biblioteca
    And debería mostrar el mensaje "Conexión exitosa"

  Scenario: Conexión fallida con URL inválida
    Given el usuario tiene una URL de servidor inválida
    When el usuario ingresa la URL del servidor "https://invalid-server.com"
    And el usuario ingresa la API key "some-api-key"
    And el usuario hace click en el botón "Conectar"
    Then la aplicación debería mostrar un mensaje de error
    And el mensaje debería decir "No se pudo conectar al servidor"
    And el botón "Conectar" debería seguir habilitado

  Scenario: Conexión fallida con API key inválida
    Given el usuario tiene una URL de servidor válida
    And el usuario tiene una API key inválida
    When el usuario ingresa la URL del servidor "https://jellyfin.example.com"
    And el usuario ingresa la API key "invalid-key"
    And el usuario hace click en el botón "Conectar"
    Then la aplicación debería mostrar un mensaje de error
    And el mensaje debería decir "API key inválida o expirada"

  Scenario: Campos vacíos en el formulario
    Given el usuario está en la pantalla de autenticación
    When el usuario deja el campo URL vacío
    And el usuario deja el campo API key vacío
    And el usuario hace click en el botón "Conectar"
    Then el botón "Conectar" debería estar deshabilitado
    And debería mostrarse el mensaje de validación "URL requerida"

  Scenario: Guardar credenciales para uso futuro
    Given el usuario ha ingresado credenciales válidas
    When el usuario marca la casilla "Recordar credenciales"
    And el usuario hace click en el botón "Conectar"
    Then las credenciales deberían guardarse en el almacenamiento local
    And en la próxima apertura los campos deberían estar prellenados