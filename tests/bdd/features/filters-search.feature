Feature: Filtros y Búsqueda
  Como usuario
  Quiero filtrar y buscar en mi biblioteca
  Para encontrar contenido específico rápidamente

  Background:
    Given el usuario está autenticado en Jellyfin
    And la biblioteca está cargada con múltiples artistas y géneros

  Scenario: Buscar por nombre de canción
    Given el usuario está en la pantalla de biblioteca
    When el usuario escribe "Yesterday" en el campo de búsqueda
    Then deberían mostrarse resultados que contengan "Yesterday"
    And los resultados deberían incluir canciones, álbumes y artistas
    And cada resultado debería mostrar su tipo (canción, álbum, artista)

  Scenario: Filtrar por género musical
    Given el usuario está en la pestaña "Artistas"
    When el usuario selecciona el filtro "Género"
    And el usuario selecciona "Rock"
    Then deberían mostrarse solo los artistas del género Rock
    And el contador debería actualizarse con el total filtrado

  Scenario: Filtrar por década
    Given el usuario está en la pestaña "Álbumes"
    When el usuario selecciona el filtro "Década"
    And el usuario selecciona "1960s"
    Then deberían mostrarse solo los álbumes de los años 60
    And los álbumes deberían estar ordenados por año

  Scenario: Combinar múltiples filtros
    Given el usuario está en la biblioteca
    When el usuario aplica el filtro "Género: Rock"
    And el usuario aplica el filtro "Década: 1970s"
    Then deberían mostrarse solo álbumes de Rock de los 70s
    And ambos filtros deberían mostrarse como tags activos

  Scenario: Limpiar filtros
    Given el usuario ha aplicado filtros
    When el usuario hace click en "Limpiar filtros"
    Then todos los filtros deberían eliminarse
    And debería mostrarse la biblioteca completa

  Scenario: Búsqueda sin resultados
    Given el usuario está en la biblioteca
    When el usuario busca "xyz123nonexistent"
    Then debería mostrarse el mensaje "No se encontraron resultados"
    And debería sugerir "Intenta con otros términos"

  Scenario: Búsqueda con filtros aplicados
    Given el usuario ha aplicado el filtro "Género: Jazz"
    When el usuario busca "Love"
    Then deberían mostrarse resultados de Jazz que contengan "Love"
    And el filtro de género debería seguir activo

  Scenario: Ordenar resultados
    Given el usuario está viendo artistas
    When el usuario selecciona "Ordenar por: A-Z"
    Then los artistas deberían ordenarse alfabéticamente
    When el usuario selecciona "Ordenar por: Añadido recientemente"
    Then los artistas deberían ordenarse por fecha de adición

  Scenario: Búsqueda reciente
    Given el usuario ha buscado "Beatles" anteriormente
    When el usuario hace click en el campo de búsqueda
    Then debería mostrarse "Beatles" en las búsquedas recientes
    When el usuario hace click en "Beatles"
    Then deberían mostrarse los resultados de "Beatles"